/**
 * The face detector against its real weights.
 *
 * Skipped unless the model is actually present, which it is not by default: the
 * weights are deliberately not in the repository, and a normal `vitest run` must
 * not download 232 KB and a native runtime to pass. Everything that can be
 * checked without them already is, in `subject-detector.test.ts`.
 *
 * To run this:
 *
 *   npm i onnxruntime-node
 *   node scripts/fetch-subject-model.mjs
 *   npx vitest run tests/subject-detector-model.test.ts
 *
 * What it can prove without a face is the whole chain around the model: that
 * the graph loads, that a frame reaches it in the layout it expects, that the
 * twelve output heads decode into boxes with valid geometry and confidence, and
 * that one process holds exactly one copy of the weights however many trackers
 * are running.
 *
 * What it cannot prove is a *positive* detection, because there is no face in a
 * fixture this suite is allowed to generate, and committing a photograph of a
 * person to test with is worse than the gap. Point `SUBJECT_DETECTOR_TEST_IMAGE`
 * at any image containing a face and the last test closes that gap locally.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FfmpegMediaService } from '@/media/media-service';
import { FfmpegFrameSource } from '@/media/frame-source';
import { runCommand } from '@/media/ffmpeg';
import { parseEnv } from '@/config/env';
import {
  createSubjectTracker,
  detectorSessionStats,
  isInstalled,
  isUsableObservation,
  releaseAllDetectorSessions,
  YuNetFaceDetector,
  type RgbFrame,
} from '@/tracking';
import type { Dimensions } from '@/domain';

const config = parseEnv(process.env, process.cwd());
const media = new FfmpegMediaService(config.media);

const SOURCE: Dimensions = { width: 1280, height: 720 };
const SOURCE_DURATION_SEC = 6;

const modelPath = config.tracking.modelPath;
const testImage = process.env.SUBJECT_DETECTOR_TEST_IMAGE?.trim();

const modelAvailable =
  isInstalled('onnxruntime-node') && (await fsp.stat(modelPath).then((s) => s.isFile()).catch(() => false));

let workDir: string;
let sourcePath: string;
let toolchainAvailable = false;

beforeAll(async () => {
  if (!modelAvailable) return;

  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-yunet-'));
  toolchainAvailable = (await media.toolchain()).available;
  if (!toolchainAvailable) return;

  sourcePath = path.join(workDir, 'source.mp4');
  await runCommand(
    config.media.ffmpegPath,
    [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', `testsrc2=s=${SOURCE.width}x${SOURCE.height}:r=25:d=${SOURCE_DURATION_SEC}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      sourcePath,
    ],
    { timeoutMs: 300_000 },
  );
}, 360_000);

afterAll(async () => {
  await releaseAllDetectorSessions();
  if (workDir) await fsp.rm(workDir, { recursive: true, force: true });
});

describe.skipIf(!modelAvailable)('YuNet against real weights', () => {
  it('loads the graph lazily and only once per process', async () => {
    await releaseAllDetectorSessions();
    expect(detectorSessionStats()).toHaveLength(0);

    const first = new YuNetFaceDetector({ modelPath });
    const second = new YuNetFaceDetector({ modelPath });

    // Constructing does not load: that is what makes `face` safe to select at
    // startup on a machine that may never run a clip.
    expect(detectorSessionStats()).toHaveLength(0);

    const frame = blankFrame(640, 360);
    await Promise.all([first.detect(frame), second.detect(frame)]);

    // One copy of the weights, two detectors holding it.
    expect(detectorSessionStats()).toEqual([{ modelPath, refs: 2 }]);

    // Releasing one leaves the other working rather than reloading.
    await first.close();
    expect(detectorSessionStats()).toEqual([{ modelPath, refs: 1 }]);
    await expect(second.detect(frame)).resolves.toBeInstanceOf(Array);

    await second.close();
    expect(detectorSessionStats()).toHaveLength(0);
  }, 120_000);

  it('returns well-formed boxes for frames of a real video', async () => {
    expect(toolchainAvailable, 'FFmpeg is required for this test').toBe(true);

    const detector = new YuNetFaceDetector({ modelPath });
    const frames = new FfmpegFrameSource({ ffmpegPath: config.media.ffmpegPath, source: SOURCE });
    let inspected = 0;

    try {
      for await (const { frame } of frames.frames({
        videoPath: sourcePath,
        startSec: 0,
        endSec: SOURCE_DURATION_SEC,
        fps: 1,
        maxFrames: 6,
        maxEdgePx: 640,
      })) {
        const detections = await detector.detect(frame);
        inspected += 1;

        // A frame with no face yields nothing, and that is not an error. What
        // matters is that whatever it does yield is inside the frame and
        // carries a probability.
        for (const detection of detections) {
          expect(detection.x).toBeGreaterThanOrEqual(0);
          expect(detection.y).toBeGreaterThanOrEqual(0);
          expect(detection.x + detection.width).toBeLessThanOrEqual(frame.width);
          expect(detection.y + detection.height).toBeLessThanOrEqual(frame.height);
          expect(detection.width).toBeGreaterThan(0);
          expect(detection.height).toBeGreaterThan(0);
          expect(detection.confidence).toBeGreaterThan(0);
          expect(detection.confidence).toBeLessThanOrEqual(1);
        }
      }
    } finally {
      await detector.close();
    }

    expect(inspected).toBe(6);
  }, 300_000);

  it('is what the selector picks when the weights are there', async () => {
    const selected = await createSubjectTracker({
      mode: 'face',
      modelPath,
      frames: new FfmpegFrameSource({ ffmpegPath: config.media.ffmpegPath, source: SOURCE }),
      fps: config.tracking.fps,
      maxFrames: config.tracking.maxFrames,
      maxEdgePx: config.tracking.maxEdgePx,
      minConfidence: config.tracking.minConfidence,
    });

    try {
      expect(selected.mode).toBe('face');
      expect(selected.detector?.id).toBe('yunet');

      // Footage with no faces tracks nothing, without throwing — the input the
      // centre-crop fallback exists for.
      const result = await selected.tracker.track({
        videoPath: sourcePath,
        range: { startSec: 0, endSec: SOURCE_DURATION_SEC },
        source: SOURCE,
      });

      expect(result.trackerId).toBe('detector:yunet');
      for (const observation of result.observations) {
        expect(isUsableObservation(observation, SOURCE)).toBe(true);
      }
    } finally {
      await selected.detector?.close();
    }
  }, 300_000);

  it.skipIf(!testImage)('finds the face in SUBJECT_DETECTOR_TEST_IMAGE', async () => {
    expect(toolchainAvailable, 'FFmpeg is required for this test').toBe(true);

    const frame = await decodeImage(testImage!, 640);
    const detector = new YuNetFaceDetector({ modelPath });

    try {
      const detections = await detector.detect(frame);

      expect(detections.length).toBeGreaterThanOrEqual(1);
      expect(detections[0]!.confidence).toBeGreaterThan(0.6);
      expect(detections[0]!.width).toBeGreaterThan(8);
      expect(detections[0]!.x + detections[0]!.width).toBeLessThanOrEqual(frame.width);
      expect(detections[0]!.y + detections[0]!.height).toBeLessThanOrEqual(frame.height);
    } finally {
      await detector.close();
    }
  }, 120_000);
});

/* -------------------------------------------------------------------------- */

const blankFrame = (width: number, height: number): RgbFrame => ({
  width,
  height,
  data: new Uint8Array(width * height * 3),
});

/** One still image as an `RgbFrame`, via the toolchain already required here. */
async function decodeImage(imagePath: string, maxEdgePx: number): Promise<RgbFrame> {
  const probed = JSON.parse(
    (
      await runCommand(config.media.ffprobePath, [
        '-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', imagePath,
      ])
    ).stdout,
  ) as { streams: { width: number; height: number }[] };

  const native = probed.streams[0]!;
  const scale = Math.min(1, maxEdgePx / Math.max(native.width, native.height));
  const width = Math.max(2, Math.round((native.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((native.height * scale) / 2) * 2);

  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(config.media.ffmpegPath, [
        '-nostdin', '-loglevel', 'error', '-i', imagePath,
        '-vf', `scale=${width}:${height}`, '-frames:v', '1',
        '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
      ]);
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', reject);
      child.on('close', () => resolve(Buffer.concat(chunks)));
    }, reject);
  });

  return { width, height, data: new Uint8Array(raw) };
}
