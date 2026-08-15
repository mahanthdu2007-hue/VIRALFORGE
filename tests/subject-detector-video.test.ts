/**
 * The whole path, on a real file: video → sampled frames → detections →
 * observations → crop plan → a rendered 9:16 clip.
 *
 * The unit tests prove the arithmetic; nothing in them can tell you whether
 * FFmpeg's raw output actually slices into frames of the size we assumed,
 * whether a frame's bytes reach a detector the right way up and the right way
 * round, or whether the boxes that come back are in a coordinate system the
 * crop path and the renderer agree with. Each of those is silent when wrong:
 * you get a plausible plan and a badly framed video.
 *
 * The fixture is generated, not committed, and is legible on purpose — a white
 * block moving left to right across a black frame. A tracker that works must
 * report a subject whose x increases over the clip, and the crop window must
 * follow it; a tracker that is subtly broken (frames transposed, timestamps
 * scrambled, BGR/RGB confused into noise) cannot produce that curve by accident.
 *
 * The luminance detector drives it rather than the face detector, for one
 * reason: this must run in a plain `vitest run` with no downloaded weights. The
 * face detector's own path over real weights is covered in
 * `subject-detector-model.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FfmpegClipRenderer } from '@/media/clip-renderer';
import { FfmpegMediaService } from '@/media/media-service';
import { FfmpegFrameSource } from '@/media/frame-source';
import { withCropPlan } from '@/media/reframe';
import { runCommand } from '@/media/ffmpeg';
import { DEFAULT_RENDER_PROFILE } from '@/media/clip-render';
import { parseEnv } from '@/config/env';
import {
  buildCropPath,
  DetectorSubjectTracker,
  LuminanceBlobDetector,
  isUsableObservation,
  observationCenter,
} from '@/tracking';
import {
  cropWindowFits,
  isCropPlanValid,
  largestCenteredWindow,
  SHORTS_ASPECT_RATIO,
  SHORTS_OUTPUT,
  type ClipPlanId,
  type Dimensions,
} from '@/domain';
import { makeClipPlan, makeVideoAsset, makeMetadata } from './helpers/fixtures';

const config = parseEnv(process.env, process.cwd());
const media = new FfmpegMediaService(config.media);

const SOURCE: Dimensions = { width: 1280, height: 720 };
const SOURCE_DURATION_SEC = 25;
const FPS = 25;

/** The moving subject, in source pixels. */
const SUBJECT = { width: 160, height: 220, y: 260 };
const TRAVEL = SOURCE.width - SUBJECT.width;
/**
 * The subject advances one step per second rather than continuously.
 *
 * `drawbox` accepts an expression for `x`, but in this FFmpeg build any `x`
 * that reads `t` silently draws nothing at all — a fixture that looks correct
 * and renders a black frame. `enable=between(t,…)` does work, so the motion is
 * built from one static box per second. A staircase is if anything the harder
 * input: the crop path has to smooth it into a pan.
 */
const STEPS = SOURCE_DURATION_SEC;
const subjectX = (step: number): number => Math.round((TRAVEL * step) / (STEPS - 1));
/** Distance covered in one second, and so the error a boundary frame can show. */
const STEP_PX = TRAVEL / (STEPS - 1);

const CUT = { order: 0, startSec: 2, endSec: 22 };
const RANGE = { startSec: CUT.startSec, endSec: CUT.endSec };
const CLIP_DURATION_SEC = CUT.endSec - CUT.startSec;

const SAMPLE_FPS = 2;
const MAX_FRAMES = 60;

/** 404×720 — the 9:16 window this source can hold. */
const WINDOW = largestCenteredWindow(SOURCE, SHORTS_OUTPUT)!;

let workDir: string;
let sourcePath: string;
let toolchainAvailable = false;

beforeAll(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-subject-'));
  toolchainAvailable = (await media.toolchain()).available;
  if (!toolchainAvailable) return;

  sourcePath = path.join(workDir, 'source-moving-subject.mp4');

  await runCommand(
    config.media.ffmpegPath,
    [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi',
      '-i',
      [
        `color=c=black:s=${SOURCE.width}x${SOURCE.height}:r=${FPS}:d=${SOURCE_DURATION_SEC}`,
        ...Array.from(
          { length: STEPS },
          (_, step) =>
            `drawbox=x=${subjectX(step)}:y=${SUBJECT.y}:w=${SUBJECT.width}:h=${SUBJECT.height}` +
            `:c=white:t=fill:enable='between(t,${step},${step + 1})'`,
        ),
      ].join(','),
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SOURCE_DURATION_SEC}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      sourcePath,
    ],
    { timeoutMs: 300_000 },
  );
}, 360_000);

afterAll(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

const newTracker = () =>
  new DetectorSubjectTracker({
    detector: new LuminanceBlobDetector(),
    frames: new FfmpegFrameSource({ ffmpegPath: config.media.ffmpegPath, source: SOURCE }),
    fps: SAMPLE_FPS,
    maxFrames: MAX_FRAMES,
    maxEdgePx: 640,
  });

describe('subject tracking over a real video', () => {
  it('samples bounded frames at the size it asked for', async () => {
    expect(toolchainAvailable, 'FFmpeg is required for this test').toBe(true);

    const source = new FfmpegFrameSource({ ffmpegPath: config.media.ffmpegPath, source: SOURCE });
    const sampled: { atSec: number; width: number; height: number; bytes: number }[] = [];

    for await (const { atSec, frame } of source.frames({
      videoPath: sourcePath,
      startSec: RANGE.startSec,
      endSec: RANGE.endSec,
      fps: SAMPLE_FPS,
      maxFrames: MAX_FRAMES,
      maxEdgePx: 640,
    })) {
      sampled.push({ atSec, width: frame.width, height: frame.height, bytes: frame.data.length });
    }

    // Six seconds at 4 fps, and nothing like the 150 frames the source holds:
    // the "do not decode every frame" requirement, measured.
    expect(sampled.length).toBeGreaterThan(20);
    expect(sampled.length).toBeLessThanOrEqual(MAX_FRAMES);

    for (const frame of sampled) {
      expect(frame.width).toBe(640);
      expect(frame.height).toBe(360);
      expect(frame.bytes).toBe(640 * 360 * 3);
      expect(frame.atSec).toBeGreaterThanOrEqual(RANGE.startSec);
      expect(frame.atSec).toBeLessThanOrEqual(RANGE.endSec);
    }

    // Ascending, evenly spaced, on the source timeline.
    expect(sampled.map((f) => f.atSec)).toEqual([...sampled.map((f) => f.atSec)].sort((a, b) => a - b));
    expect(sampled[1]!.atSec - sampled[0]!.atSec).toBeCloseTo(1 / SAMPLE_FPS, 6);
  }, 120_000);

  it('stops FFmpeg early when the consumer stops reading', async () => {
    const source = new FfmpegFrameSource({ ffmpegPath: config.media.ffmpegPath, source: SOURCE });
    let seen = 0;

    for await (const sample of source.frames({
      videoPath: sourcePath,
      startSec: 0,
      endSec: SOURCE_DURATION_SEC,
      fps: 25,
      maxFrames: 200,
      maxEdgePx: 640,
    })) {
      expect(sample.frame.data).toHaveLength(640 * 360 * 3);
      seen += 1;
      if (seen === 3) break;
    }

    // Abandoning the iterator must not throw or hang: the generator's cleanup
    // kills the child rather than waiting for a full decode.
    expect(seen).toBe(3);
  }, 120_000);

  it('returns valid observations that follow the subject', async () => {
    const result = await newTracker().track({ videoPath: sourcePath, range: RANGE, source: SOURCE });

    expect(result.trackerId).toBe('detector:luminance');
    expect(result.observations.length).toBeGreaterThan(15);

    let previousAt = -Infinity;
    for (const observation of result.observations) {
      // Timestamps: real, ordered, inside the requested range.
      expect(Number.isFinite(observation.atSec)).toBe(true);
      expect(observation.atSec).toBeGreaterThanOrEqual(RANGE.startSec);
      expect(observation.atSec).toBeLessThanOrEqual(RANGE.endSec);
      expect(observation.atSec).toBeGreaterThan(previousAt);
      previousAt = observation.atSec;

      // Boxes: inside the source frame, on every side.
      expect(observation.x).toBeGreaterThanOrEqual(0);
      expect(observation.y).toBeGreaterThanOrEqual(0);
      expect(observation.x + observation.width).toBeLessThanOrEqual(SOURCE.width);
      expect(observation.y + observation.height).toBeLessThanOrEqual(SOURCE.height);
      expect(observation.width).toBeGreaterThan(0);
      expect(observation.height).toBeGreaterThan(0);

      // Confidence: a probability, not a score.
      expect(observation.confidence).toBeGreaterThan(0);
      expect(observation.confidence).toBeLessThanOrEqual(1);

      expect(isUsableObservation(observation, SOURCE)).toBe(true);
    }

    // One subject, one identity, for the whole clip.
    expect(new Set(result.observations.map((o) => o.subjectId)).size).toBe(1);
    expect(result.observations[0]!.subjectId).not.toBeNull();

    // And it is *the* subject: the detected centre tracks the drawn one, which
    // is the assertion no amount of internally-consistent-but-wrong plumbing
    // can satisfy.
    for (const observation of result.observations) {
      const centre = observationCenter(observation);
      const expectedX = subjectX(Math.floor(observation.atSec)) + SUBJECT.width / 2;

      // One step of slack: a sample landing on a second boundary legitimately
      // sees either side of the staircase.
      expect(Math.abs(centre.x - expectedX)).toBeLessThan(STEP_PX + 30);
      expect(Math.abs(centre.y - (SUBJECT.y + SUBJECT.height / 2))).toBeLessThan(30);
    }

    // It crossed the frame, rather than being found in one place all clip.
    const xs = result.observations.map((o) => observationCenter(o).x);
    expect(xs.at(-1)! - xs[0]!).toBeGreaterThan(TRAVEL * 0.5);
  }, 180_000);

  it('turns those observations into a crop plan that pans', async () => {
    const result = await newTracker().track({ videoPath: sourcePath, range: RANGE, source: SOURCE });
    const plan = buildCropPath(result.observations, {
      source: SOURCE,
      range: RANGE,
      trackerId: result.trackerId,
    });

    expect(plan.strategy).toBe('tracked');
    expect(isCropPlanValid(plan, { startSec: 0, endSec: CLIP_DURATION_SEC })).toBe(true);
    expect(plan.output).toEqual(SHORTS_OUTPUT);
    expect(plan.rationale).toContain('detector:luminance');

    for (const keyframe of plan.keyframes) {
      expect(cropWindowFits(keyframe, SOURCE)).toBe(true);
      expect(keyframe.width).toBe(WINDOW.width);
      expect(keyframe.height).toBe(WINDOW.height);
      expect(keyframe.atSec).toBeGreaterThanOrEqual(0);
      expect(keyframe.atSec).toBeLessThanOrEqual(CLIP_DURATION_SEC);
    }

    const xs = plan.keyframes.map((kf) => kf.x);
    expect(xs.at(-1)!).toBeGreaterThan(xs[0]! + 200);
    // Monotonic: the subject only ever moves right, so a window that doubles
    // back is smoothing or velocity limiting gone wrong.
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  }, 180_000);

  it('still renders a playable 9:16 clip from the tracked plan', async () => {
    const result = await newTracker().track({ videoPath: sourcePath, range: RANGE, source: SOURCE });
    const plan = buildCropPath(result.observations, {
      source: SOURCE,
      range: RANGE,
      trackerId: result.trackerId,
    });

    const outputPath = path.join(workDir, 'clip-tracked-subject.mp4');
    const renderer = new FfmpegClipRenderer({
      ffmpegPath: config.media.ffmpegPath,
      ffprobePath: config.media.ffprobePath,
      media,
      commandTimeoutMs: 300_000,
    });

    const rendered = await renderer.render({
      source: makeVideoAsset({
        metadata: makeMetadata({
          durationSec: SOURCE_DURATION_SEC,
          width: SOURCE.width,
          height: SOURCE.height,
          fps: FPS,
        }),
      }),
      sourcePath,
      plan: makeClipPlan([CUT], { id: 'subject-plan-1' as ClipPlanId }),
      outputPath,
      profile: withCropPlan(DEFAULT_RENDER_PROFILE, plan),
    });

    expect(rendered.mode).toBe('reencode');
    expect(rendered.width).toBe(SHORTS_OUTPUT.width);
    expect(rendered.height).toBe(SHORTS_OUTPUT.height);
    expect(rendered.hasAudio).toBe(true);

    const probed = JSON.parse(
      (
        await runCommand(config.media.ffprobePath, [
          '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', outputPath,
        ])
      ).stdout,
    ) as { streams: { codec_type: string; width?: number; height?: number; display_aspect_ratio?: string }[] };

    const video = probed.streams.find((s) => s.codec_type === 'video')!;
    expect(video.width).toBe(SHORTS_OUTPUT.width);
    expect(video.height).toBe(SHORTS_OUTPUT.height);
    expect(video.width! / video.height!).toBe(SHORTS_ASPECT_RATIO);
    expect(video.display_aspect_ratio).toBe('9:16');

    // Decodes cleanly end to end.
    const decoded = await runCommand(
      config.media.ffmpegPath,
      ['-nostdin', '-v', 'error', '-i', outputPath, '-f', 'null', '-'],
      { timeoutMs: 300_000 },
    );
    expect(decoded.stderr.trim()).toBe('');

    // The subject is actually in the finished frame: the white block should
    // dominate the middle of the output for the whole clip, which it cannot do
    // under a static centre crop of a subject that starts at the left edge.
    const brightness = await centreBrightness(outputPath);
    expect(brightness.length).toBeGreaterThan(CLIP_DURATION_SEC * 10);
    expect(Math.min(...brightness)).toBeGreaterThan(20);
  }, 300_000);
});

/**
 * Mean luma of the middle third of each output frame.
 *
 * Read back through FFmpeg rather than asserted from the plan, because the plan
 * being right and the render being right are different claims.
 */
async function centreBrightness(videoPath: string): Promise<number[]> {
  const { stdout } = await runCommand(
    config.media.ffprobePath,
    [
      '-v', 'error',
      '-f', 'lavfi',
      '-i', `movie=${ffprobeSource(videoPath)},crop=w=iw/3:h=ih/3,signalstats`,
      '-show_entries', 'frame_tags=lavfi.signalstats.YAVG',
      '-print_format', 'json',
    ],
    { timeoutMs: 300_000 },
  );

  const parsed = JSON.parse(stdout) as {
    frames?: { tags?: Record<string, string> }[];
  };

  return (parsed.frames ?? [])
    .map((frame) => Number(frame.tags?.['lavfi.signalstats.YAVG']))
    .filter((value) => Number.isFinite(value));
}

/** `movie=` is a filtergraph argument: Windows drive colons and slashes bite. */
const ffprobeSource = (videoPath: string): string =>
  videoPath.replace(/\\/g, '/').replace(/:/g, '\\\\:');
