/**
 * Sampled raw frames out of a video, for subject detection.
 *
 * The FFmpeg side of `FrameSource`. Every other media operation in this app
 * writes a file and reports its path; this one cannot, because the consumer
 * wants pixels and writing a few hundred PNGs to disk to hand them over would be
 * slower and messier than the pipe. So this is the one place that reads media
 * bytes into the process — and the whole design of the module is about bounding
 * that:
 *
 *  - FFmpeg is asked for `fps` frames per second and no more than `maxFrames`
 *    of them, downscaled to fit `maxEdgePx`. The decode is bounded before a
 *    byte is read.
 *  - `rgb24` at a known size means a frame is a fixed byte count, so the stream
 *    is sliced into frames without parsing a container.
 *  - Frames are yielded one at a time and the consumer's `await` pauses the
 *    pipe, so resident memory is one frame plus one pipe chunk — roughly a
 *    megabyte at 640×360, whatever the length of the video.
 *
 * The source file is opened read-only and never modified, like everywhere else
 * in this layer.
 */

import { spawn } from 'node:child_process';
import { mediaError } from '@/lib/errors';
import {
  decodeDimensions,
  frameByteLength,
  type FrameSampleRequest,
  type FrameSource,
  type SampledFrame,
} from '@/tracking';
import type { Dimensions } from '@/domain';

export interface FfmpegFrameSourceOptions {
  readonly ffmpegPath: string;
  /**
   * Native size of the sources this instance will read. Needed up front because
   * the frame's byte length must be known before the stream can be sliced;
   * ffprobe has already established it by the time tracking runs.
   */
  readonly source: Dimensions;
  /** Ceiling for one extraction. Decoding a long range is not instant. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** FFmpeg's diagnostics are short; this is only to stop a pathological loop. */
const MAX_STDERR_CHARS = 4000;

export class FfmpegFrameSource implements FrameSource {
  readonly id = 'ffmpeg';

  constructor(private readonly options: FfmpegFrameSourceOptions) {}

  async *frames(request: FrameSampleRequest): AsyncIterable<SampledFrame> {
    const size = decodeDimensions(this.options.source, request.maxEdgePx);
    const durationSec = request.endSec - request.startSec;
    const fps = request.fps;
    const maxFrames = Math.floor(request.maxFrames);

    if (!size || !(durationSec > 0) || !(fps > 0) || !(maxFrames > 0)) return;

    const frameBytes = frameByteLength(size.width, size.height);
    const args = buildSampleArgs(request, size, maxFrames);

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(this.options.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = child.stdout;

    // Held in one object rather than as separate `let`s: they are written from
    // event callbacks and read after an `await`, which is exactly the shape
    // narrowing gets wrong.
    const state = {
      stderr: '',
      spawnFailure: null as NodeJS.ErrnoException | null,
      timedOut: false,
      stoppedEarly: false,
    };

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (state.stderr.length < MAX_STDERR_CHARS) state.stderr += chunk;
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      state.spawnFailure = error;
    });

    const exit = new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
    });

    const timer = setTimeout(() => {
      state.timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    try {
      if (!stdout) throw mediaError('frame_sampling_failed', 'FFmpeg produced no output stream.');

      const pending: Buffer[] = [];
      let pendingBytes = 0;
      let index = 0;

      for await (const chunk of stdout as AsyncIterable<Buffer>) {
        pending.push(chunk);
        pendingBytes += chunk.length;
        if (pendingBytes < frameBytes) continue;

        // Concatenated only once a whole frame is available, so a 64 KB pipe
        // chunk does not trigger a copy of the frame accumulated so far.
        let buffer = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
        pending.length = 0;

        while (buffer.length >= frameBytes && index < maxFrames) {
          // Copied out: `subarray` would alias the accumulation buffer, and the
          // consumer is entitled to keep the frame past the next iteration.
          const data = new Uint8Array(buffer.subarray(0, frameBytes));
          buffer = buffer.subarray(frameBytes);

          yield {
            atSec: round6(request.startSec + index / fps),
            frame: { width: size.width, height: size.height, data },
          };
          index += 1;
        }

        if (index >= maxFrames) {
          state.stoppedEarly = true;
          break;
        }

        pending.push(buffer);
        pendingBytes = buffer.length;
      }
    } finally {
      clearTimeout(timer);
      // Covers both the early break above and a consumer that abandoned the
      // iterator: either way FFmpeg must not be left decoding into a dead pipe.
      if (child.exitCode === null && child.signalCode === null) {
        state.stoppedEarly = true;
        child.kill('SIGKILL');
      }
    }

    const code = await exit;
    const failure = state.spawnFailure;

    if (failure) {
      throw mediaError(
        failure.code === 'ENOENT' ? 'toolchain_missing' : 'command_failed',
        `Frame sampling could not start: ${failure.message}`,
        { cause: failure, details: { bin: this.options.ffmpegPath } },
      );
    }

    if (state.timedOut) {
      throw mediaError('frame_sampling_timeout', 'Frame sampling took too long and was stopped.', {
        details: { timeoutMs },
      });
    }

    // A non-zero code after a deliberate kill is our own doing, not a failure.
    if (code !== 0 && !state.stoppedEarly) {
      throw mediaError(
        'frame_sampling_failed',
        `Frame sampling failed: ${firstLine(state.stderr) || `exit ${code}`}`,
        { details: { exitCode: code }, logDetails: { args, stderr: state.stderr } },
      );
    }
  }
}

/**
 * The extraction command.
 *
 * `-ss` before `-i` so FFmpeg seeks the container rather than decoding to the
 * start point — the same choice `buildCutArgs` makes, and for the same reason.
 * `fps` resamples the timeline to the requested rate, which is what makes frame
 * *n* land at `start + n/fps` and lets the caller timestamp frames by counting
 * rather than by parsing.
 */
export function buildSampleArgs(
  request: FrameSampleRequest,
  size: Dimensions,
  maxFrames: number,
): readonly string[] {
  return [
    '-nostdin',
    '-loglevel',
    'error',
    '-ss',
    String(request.startSec),
    '-t',
    String(request.endSec - request.startSec),
    '-i',
    request.videoPath,
    // Nothing but the picture: audio, subtitle and data streams are cost here.
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `fps=${request.fps},scale=${size.width}:${size.height}:flags=bilinear`,
    '-frames:v',
    String(maxFrames),
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ];
}

const firstLine = (text: string): string => text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
