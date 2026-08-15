/**
 * The real face detector: YuNet on ONNX Runtime, on the CPU, in this process.
 *
 * Why this and not something bigger: the whole job is "point a 9:16 window at
 * the person talking", and a 232 KB face detector answers that directly at
 * ~20 ms per frame on a laptop CPU. A general object detector would be an order
 * of magnitude larger, slower, and would still need its "person" boxes reduced
 * to a head position before the crop path could use them.
 *
 * Three properties are deliberate and worth not breaking:
 *
 *  - **The dependency is optional.** `onnxruntime-node` is an optional
 *    dependency and is imported through a variable specifier, so it is neither
 *    bundled nor loaded unless a face-tracking run actually starts. An install
 *    without it, or without the weights, degrades to the deterministic tracker —
 *    it does not fail to boot.
 *  - **Loading is lazy and shared.** The session is created on the first frame
 *    and cached per model path for the life of the process. Two trackers running
 *    concurrently share one copy of the weights and one thread pool; the
 *    alternative is a second few-hundred-megabyte runtime for no benefit.
 *  - **Nothing leaves the machine.** Inference is local. No frame is uploaded
 *    anywhere, and the module makes no network calls at all — obtaining the
 *    model is a documented setup step, not something this code does behind the
 *    user's back.
 */

import path from 'node:path';
import { mediaError } from '@/lib/errors';
import type { FrameDetection, FrameDetector, RgbFrame } from './types';
import {
  decodeYuNet,
  letterboxFrame,
  toFrameCoordinates,
  YUNET_DECODE_DEFAULTS,
  YUNET_INPUT_SIZE,
  type YuNetDecodeOptions,
  type YuNetOutputs,
} from './yunet-decode';

/** The file name the setup instructions use. Only a default; any path works. */
export const YUNET_MODEL_FILENAME = 'face_detection_yunet_2023mar.onnx';

export interface YuNetFaceDetectorOptions extends Partial<YuNetDecodeOptions> {
  /** Path to the `.onnx` weights. Resolved against the process cwd if relative. */
  readonly modelPath: string;
  /**
   * Threads ONNX Runtime may use per operator. Held low on purpose: this runs
   * beside FFmpeg, and saturating every core makes the render it feeds slower
   * than the detection it speeds up.
   */
  readonly threads?: number;
}

export class YuNetFaceDetector implements FrameDetector {
  readonly id = 'yunet';

  private readonly modelPath: string;
  private readonly decodeOptions: YuNetDecodeOptions;
  /** Serialises `run` calls; one session is not a pool. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Whether this instance holds a reference on the shared session. */
  private holdsSession = false;

  constructor(private readonly options: YuNetFaceDetectorOptions) {
    this.modelPath = path.resolve(options.modelPath);
    this.decodeOptions = {
      minConfidence: options.minConfidence ?? YUNET_DECODE_DEFAULTS.minConfidence,
      iouThreshold: options.iouThreshold ?? YUNET_DECODE_DEFAULTS.iouThreshold,
      maxDetections: options.maxDetections ?? YUNET_DECODE_DEFAULTS.maxDetections,
    };
  }

  async detect(frame: RgbFrame): Promise<readonly FrameDetection[]> {
    // Reference taken synchronously, before the first `await`, so two frames
    // detected concurrently cannot each take one.
    const pending = loadSession(this.modelPath, this.options.threads ?? DEFAULT_THREADS);
    if (!this.holdsSession) {
      this.holdsSession = true;
      retain(this.modelPath);
    }

    const session = await pending;
    const { input, box } = letterboxFrame(frame, YUNET_INPUT_SIZE);

    const run = this.queue.then(() =>
      session.run({
        input: new session.Tensor('float32', input, [1, 3, YUNET_INPUT_SIZE, YUNET_INPUT_SIZE]),
      }),
    );
    // Chained before awaiting so a rejection cannot leave the queue poisoned for
    // the next frame, and so the next caller still waits its turn.
    this.queue = run.catch(() => undefined);

    // The decoder takes plain arrays, not tensors: that is what keeps it — and
    // every arithmetic mistake it could contain — testable without ONNX.
    const outputs: YuNetOutputs = Object.fromEntries(
      Object.entries(await run).map(([name, tensor]) => [name, tensor.data]),
    );

    return decodeYuNet(outputs, this.decodeOptions, YUNET_INPUT_SIZE)
      .map((detection) => toFrameCoordinates(detection, box, frame))
      .filter((detection): detection is FrameDetection => detection !== null);
  }

  async close(): Promise<void> {
    if (!this.holdsSession) return;
    this.holdsSession = false;
    await release(this.modelPath);
  }
}

/* -------------------------------------------------------------------------- */
/* Session cache                                                              */
/* -------------------------------------------------------------------------- */

/** Cores are better spent on the encode; two is enough for a 640² model. */
const DEFAULT_THREADS = 2;

interface OrtTensor {
  readonly data: ArrayLike<number>;
}

interface LoadedSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
  readonly Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor;
}

interface OrtModule {
  readonly Tensor: LoadedSession['Tensor'];
  readonly InferenceSession: {
    create(modelPath: string, options?: Record<string, unknown>): Promise<{
      run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
      release?(): Promise<void>;
    }>;
  };
}

interface SessionEntry {
  /**
   * The *promise*, not the session, so two concurrent first frames wait on a
   * single load instead of racing into two copies of the weights.
   */
  readonly session: Promise<LoadedSession>;
  /** Detectors currently using it. The session lives until this reaches zero. */
  refs: number;
}

/** One entry per model path, for the life of the process. */
const sessions = new Map<string, SessionEntry>();

function loadSession(modelPath: string, threads: number): Promise<LoadedSession> {
  const existing = sessions.get(modelPath);
  if (existing) return existing.session;

  const session = createSession(modelPath, threads).catch((error: unknown) => {
    // A failed load must not be cached, or a fixed install would still be broken
    // until the process restarts.
    sessions.delete(modelPath);
    throw error;
  });

  sessions.set(modelPath, { session, refs: 0 });
  return session;
}

const retain = (modelPath: string): void => {
  const entry = sessions.get(modelPath);
  if (entry) entry.refs += 1;
};

/**
 * Drop one reference, and the session with the last of them.
 *
 * Counted rather than closed on the first `close()` because trackers are
 * per-clip and the weights are not: releasing while another clip is still
 * detecting would reload a few hundred megabytes of runtime for nothing.
 */
async function release(modelPath: string): Promise<void> {
  const entry = sessions.get(modelPath);
  if (!entry) return;

  entry.refs -= 1;
  if (entry.refs > 0) return;

  sessions.delete(modelPath);
  await entry.session.then((session) => session.release()).catch(() => undefined);
}

/** Loaded models and how many detectors hold each. Diagnostics and tests. */
export const detectorSessionStats = (): readonly { readonly modelPath: string; readonly refs: number }[] =>
  [...sessions.entries()].map(([modelPath, entry]) => ({ modelPath, refs: entry.refs }));

async function createSession(modelPath: string, threads: number): Promise<LoadedSession> {
  const ort = await importOnnxRuntime();

  let session: Awaited<ReturnType<OrtModule['InferenceSession']['create']>>;
  try {
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      logSeverityLevel: 3,
    });
  } catch (error) {
    throw mediaError(
      'subject_model_unreadable',
      `The subject detection model could not be loaded from ${path.basename(modelPath)}.`,
      { cause: error, details: { modelPath: path.basename(modelPath) }, logDetails: { modelPath } },
    );
  }

  return {
    run: (feeds) => session.run(feeds),
    release: async () => {
      await session.release?.();
    },
    Tensor: ort.Tensor,
  };
}

/**
 * Import the runtime without letting a bundler follow it.
 *
 * The specifier is a variable so Next's build does not try to trace a native
 * `.node` binary into the server bundle, and so TypeScript does not require the
 * optional package to be installed for `tsc` to pass.
 */
async function importOnnxRuntime(): Promise<OrtModule> {
  const specifier = 'onnxruntime-node';
  try {
    return (await import(/* webpackIgnore: true */ specifier)) as unknown as OrtModule;
  } catch (error) {
    throw mediaError(
      'subject_runtime_missing',
      'Face tracking needs the optional "onnxruntime-node" package, which is not installed.',
      { cause: error },
    );
  }
}

/** Test hook — drops every cached session regardless of references. */
export async function releaseAllDetectorSessions(): Promise<void> {
  const entries = [...sessions.values()];
  sessions.clear();
  await Promise.all(entries.map((entry) => entry.session.then((s) => s.release()).catch(() => undefined)));
}
