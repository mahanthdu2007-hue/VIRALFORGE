/**
 * End-to-end proof of the render phase: `ClipPlan` → `SubjectTracker` →
 * `CropPlan` → `RenderProfile` → `FfmpegClipRenderer` → a real file on disk.
 *
 * Uses `FixtureSubjectTracker` (an existing test tracker, not the YuNet
 * detector) via `trackerOverride`, so this proves the wiring without needing
 * the optional `onnxruntime-node` package or any model weights. A second case
 * proves the fallback path — an empty tracker still produces a valid,
 * playable centre-cropped clip.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderClipPlan } from '@/pipeline/render-clip';
import { FfmpegMediaService } from '@/media/media-service';
import { runCommand } from '@/media/ffmpeg';
import { parseEnv } from '@/config/env';
import { FixtureSubjectTracker, NullSubjectTracker, type SubjectObservation } from '@/tracking';
import { SHORTS_ASPECT_RATIO, type ClipPlanId } from '@/domain';
import { makeClipPlan, makeVideoAsset, makeMetadata } from './helpers/fixtures';

const config = parseEnv(process.env, process.cwd());
const media = new FfmpegMediaService(config.media);

const SOURCE_WIDTH = 1920;
const SOURCE_HEIGHT = 1080;
const SOURCE_DURATION_SEC = 25;
const CUT = { order: 0, startSec: 5, endSec: 20 };

let workDir: string;
let sourcePath: string;
let toolchainAvailable = false;

beforeAll(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-render-clip-'));
  toolchainAvailable = (await media.toolchain()).available;
  if (!toolchainAvailable) return;

  sourcePath = path.join(workDir, 'source-1920x1080.mp4');

  await runCommand(
    config.media.ffmpegPath,
    [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=${SOURCE_WIDTH}x${SOURCE_HEIGHT}:rate=25:duration=${SOURCE_DURATION_SEC}`,
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

const trackingConfig = {
  mode: 'center' as const,
  modelPath: '',
  fps: 2,
  maxFrames: 240,
  maxEdgePx: 640,
  minConfidence: 0.4,
};

describe('renderClipPlan', () => {
  it('tracks a moving fixture subject through to a playable 9:16 render', async () => {
    expect(toolchainAvailable, 'FFmpeg is required for this test').toBe(true);

    const outputPath = path.join(workDir, 'clip-tracked.mp4');
    const observations: SubjectObservation[] = [
      { atSec: 5, x: 100, y: 60, width: 500, height: 900, confidence: 0.9, subjectId: 'a' },
      { atSec: 12, x: 900, y: 60, width: 500, height: 900, confidence: 0.9, subjectId: 'a' },
      { atSec: 20, x: 1300, y: 60, width: 500, height: 900, confidence: 0.9, subjectId: 'a' },
    ];
    const tracker = new FixtureSubjectTracker({ id: 'fixture-e2e', observations });

    const result = await renderClipPlan(
      {
        ffmpegPath: config.media.ffmpegPath,
        ffprobePath: config.media.ffprobePath,
        media,
        tracking: trackingConfig,
        trackerOverride: tracker,
        commandTimeoutMs: 300_000,
      },
      {
        source: makeVideoAsset({
          metadata: makeMetadata({
            durationSec: SOURCE_DURATION_SEC,
            width: SOURCE_WIDTH,
            height: SOURCE_HEIGHT,
            fps: 25,
            videoCodec: 'h264',
            audioCodec: 'aac',
          }),
        }),
        sourcePath,
        plan: makeClipPlan([CUT], { id: 'render-clip-tracked' as ClipPlanId, cropPlan: null }),
        outputPath,
      },
    );

    expect(result.trackerId).toBe('fixture-e2e');
    expect(result.rendered.width).toBe(1080);
    expect(result.rendered.height).toBe(1920);
    expect(result.rendered.hasAudio).toBe(true);
    // Filtering (crop + scale) rules out stream copy.
    expect(result.rendered.mode).toBe('reencode');

    const probed = await probeStreams(outputPath);
    const video = probed.streams.find((s) => s.codec_type === 'video')!;
    const audio = probed.streams.find((s) => s.codec_type === 'audio')!;

    expect(video.width).toBe(1080);
    expect(video.height).toBe(1920);
    expect(video.width! / video.height!).toBe(SHORTS_ASPECT_RATIO);
    expect(audio.codec_name).toBe('aac');
    expect(Number(probed.format.duration)).toBeCloseTo(CUT.endSec - CUT.startSec, 0);

    // Playable: decode every packet, expect nothing on stderr.
    const decoded = await runCommand(
      config.media.ffmpegPath,
      ['-nostdin', '-v', 'error', '-i', outputPath, '-f', 'null', '-'],
      { timeoutMs: 300_000 },
    );
    expect(decoded.stderr.trim()).toBe('');

    // No temp directories left behind.
    const leftovers = (await fsp.readdir(workDir)).filter((entry) => entry.startsWith('.render-'));
    expect(leftovers).toEqual([]);
  }, 600_000);

  it('falls back to a centre crop and still renders a playable clip when tracking finds nothing', async () => {
    expect(toolchainAvailable, 'FFmpeg is required for this test').toBe(true);

    const outputPath = path.join(workDir, 'clip-fallback.mp4');

    const result = await renderClipPlan(
      {
        ffmpegPath: config.media.ffmpegPath,
        ffprobePath: config.media.ffprobePath,
        media,
        tracking: trackingConfig,
        trackerOverride: new NullSubjectTracker(),
        commandTimeoutMs: 300_000,
      },
      {
        source: makeVideoAsset({
          metadata: makeMetadata({
            durationSec: SOURCE_DURATION_SEC,
            width: SOURCE_WIDTH,
            height: SOURCE_HEIGHT,
            fps: 25,
            videoCodec: 'h264',
            audioCodec: 'aac',
          }),
        }),
        sourcePath,
        plan: makeClipPlan([CUT], { id: 'render-clip-fallback' as ClipPlanId, cropPlan: null }),
        outputPath,
      },
    );

    expect(result.profile.videoFilters.length).toBeGreaterThan(0);
    expect(result.rendered.width).toBe(1080);
    expect(result.rendered.height).toBe(1920);
    expect(result.rendered.hasAudio).toBe(true);

    const decoded = await runCommand(
      config.media.ffmpegPath,
      ['-nostdin', '-v', 'error', '-i', outputPath, '-f', 'null', '-'],
      { timeoutMs: 300_000 },
    );
    expect(decoded.stderr.trim()).toBe('');
  }, 600_000);
});

/* -------------------------------------------------------------------------- */

interface ProbedStreams {
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    duration?: string;
  }[];
  format: { duration: string };
}

async function probeStreams(filePath: string): Promise<ProbedStreams> {
  const { stdout } = await runCommand(config.media.ffprobePath, [
    '-v', 'error',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,duration:format=duration',
    '-print_format', 'json',
    filePath,
  ]);

  return JSON.parse(stdout) as ProbedStreams;
}
