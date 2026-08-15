/**
 * The moving crop, against real FFmpeg.
 *
 * `crop-path-render.test.ts` asserts the expression and the command line;
 * nothing there can tell you whether FFmpeg accepts the filter, whether the
 * quoted commas survive its filtergraph parser, or whether `t` in the
 * expression means what we think it means after an input seek. This renders a
 * generated source through the real renderer and reads the result back with
 * ffprobe.
 *
 * The source is deliberately readable by a machine: the left half of the frame
 * is white and the right half black, so where the window is at any instant is
 * visible in the output's average brightness. A crop that never moved, moved
 * the wrong way, or jumped would all produce a different brightness curve from
 * one that pans smoothly left to right.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FfmpegClipRenderer } from '@/media/clip-renderer';
import { FfmpegMediaService } from '@/media/media-service';
import { withCropPlan } from '@/media/reframe';
import { runCommand } from '@/media/ffmpeg';
import { DEFAULT_RENDER_PROFILE } from '@/media/clip-render';
import { parseEnv } from '@/config/env';
import {
  largestCenteredWindow,
  SHORTS_ASPECT_RATIO,
  SHORTS_OUTPUT,
  type ClipPlanId,
  type CropPlan,
  type Dimensions,
} from '@/domain';
import { makeClipPlan, makeVideoAsset, makeMetadata } from './helpers/fixtures';

const config = parseEnv(process.env, process.cwd());
const media = new FfmpegMediaService(config.media);

const SOURCE: Dimensions = { width: 1920, height: 1080 };
const SOURCE_DURATION_SEC = 25;
const FPS = 25;
/** The white half of the source: x in [0, 960). */
const WHITE_WIDTH = 960;

const CUT = { order: 0, startSec: 5, endSec: 20 };
const CLIP_DURATION_SEC = CUT.endSec - CUT.startSec;

/** 594×1056 — the same 9:16 window the centre crop uses on this source. */
const WINDOW = largestCenteredWindow(SOURCE, SHORTS_OUTPUT)!;
const MAX_X = SOURCE.width - WINDOW.width;

/**
 * A path that starts wholly inside the white half and ends wholly inside the
 * black half, moving through the boundary in the middle of the clip.
 */
const PLAN: CropPlan = {
  strategy: 'tracked',
  source: SOURCE,
  output: SHORTS_OUTPUT,
  targetAspectRatio: SHORTS_ASPECT_RATIO,
  keyframes: [
    { atSec: 0, x: 0, y: 12, ...size() },
    { atSec: 3, x: 0, y: 12, ...size() },
    { atSec: 6, x: 300, y: 12, ...size() },
    { atSec: 11, x: 1000, y: 12, ...size() },
    { atSec: CLIP_DURATION_SEC, x: MAX_X, y: 12, ...size() },
  ],
  rationale: 'Test path: pans left to right across the clip.',
};

function size() {
  return { width: WINDOW.width, height: WINDOW.height };
}

let workDir: string;
let sourcePath: string;
let toolchainAvailable = false;
let sourceDigestBefore: string;

beforeAll(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-croppath-'));
  toolchainAvailable = (await media.toolchain()).available;
  if (!toolchainAvailable) return;

  sourcePath = path.join(workDir, 'source-halves.mp4');

  await runCommand(
    config.media.ffmpegPath,
    [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi',
      '-i',
      `color=c=black:s=${SOURCE.width}x${SOURCE.height}:r=${FPS}:d=${SOURCE_DURATION_SEC},` +
        `drawbox=x=0:y=0:w=${WHITE_WIDTH}:h=${SOURCE.height}:c=white:t=fill`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SOURCE_DURATION_SEC}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      sourcePath,
    ],
    { timeoutMs: 300_000 },
  );

  sourceDigestBefore = await digest(sourcePath);
}, 360_000);

afterAll(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

describe('dynamic crop render of a real source', () => {
  it('pans smoothly across a playable 9:16 clip that keeps its audio', async () => {
    expect(toolchainAvailable, 'FFmpeg is required for this test').toBe(true);

    const outputPath = path.join(workDir, 'clip-tracked.mp4');
    const profile = withCropPlan(DEFAULT_RENDER_PROFILE, PLAN);

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
          videoCodec: 'h264',
          audioCodec: 'aac',
        }),
      }),
      sourcePath,
      plan: makeClipPlan([CUT], { id: 'crop-path-plan-1' as ClipPlanId }),
      outputPath,
      profile,
    });

    // Filtering rules out stream copy; the renderer chose that itself.
    expect(rendered.mode).toBe('reencode');
    expect(rendered.modeReason).toBe('filters_requested');
    expect(rendered.width).toBe(1080);
    expect(rendered.height).toBe(1920);
    expect(rendered.hasAudio).toBe(true);

    /* --- shape, playability, sync ---------------------------------------- */

    const probed = await probeStreams(outputPath);
    const video = probed.streams.find((s) => s.codec_type === 'video')!;
    const audio = probed.streams.find((s) => s.codec_type === 'audio')!;

    expect(video.width).toBe(1080);
    expect(video.height).toBe(1920);
    expect(video.width! / video.height!).toBe(SHORTS_ASPECT_RATIO);
    // Square pixels: 9:16 on screen, not merely in stored samples.
    expect(video.display_aspect_ratio).toBe('9:16');

    expect(audio.codec_name).toBe('aac');
    expect(Number(probed.format.duration)).toBeCloseTo(CLIP_DURATION_SEC, 0);
    // Equal-length tracks: moving the window did not shift the speech.
    expect(Math.abs(Number(video.duration) - Number(audio.duration))).toBeLessThan(0.1);

    const decoded = await runCommand(
      config.media.ffmpegPath,
      ['-nostdin', '-v', 'error', '-i', outputPath, '-f', 'null', '-'],
      { timeoutMs: 300_000 },
    );
    expect(decoded.stderr.trim()).toBe('');

    /* --- the window actually moved, and moved smoothly ------------------- */

    const brightness = await frameBrightness(outputPath);
    expect(brightness.length).toBeGreaterThan(CLIP_DURATION_SEC * FPS * 0.9);

    const first = brightness[0]!;
    const last = brightness[brightness.length - 1]!;
    // Starts inside the white half, ends inside the black half.
    expect(first).toBeGreaterThan(200);
    expect(last).toBeLessThan(40);

    // A cut would go bright to dark in one frame. A pan spends the whole time
    // the window straddles the boundary — 594px of travel — in between.
    const between = brightness.filter((value) => value > 40 && value < 200);
    expect(between.length).toBeGreaterThan(20);

    // No sudden jumps: consecutive frames differ by a fraction of the full swing.
    const biggestStep = Math.max(
      ...brightness.slice(1).map((value, i) => Math.abs(value - brightness[i]!)),
    );
    expect(biggestStep).toBeLessThan(30);

    // Held head: the first three seconds are pinned at x=0, so nothing changes.
    const held = brightness.slice(0, 2 * FPS);
    expect(Math.max(...held) - Math.min(...held)).toBeLessThanOrEqual(2);

    /* --- the source is untouched, and nothing is left behind ------------- */

    expect(await digest(sourcePath)).toBe(sourceDigestBefore);

    const leftovers = (await fsp.readdir(workDir)).filter((entry) => entry.startsWith('.render-'));
    expect(leftovers).toEqual([]);
    expect((await fsp.readdir(workDir)).sort()).toEqual(
      ['clip-tracked.mp4', 'source-halves.mp4'],
    );
  }, 600_000);
});

/* -------------------------------------------------------------------------- */

const digest = async (filePath: string): Promise<string> =>
  crypto.createHash('sha256').update(await fsp.readFile(filePath)).digest('hex');

interface ProbedStreams {
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    display_aspect_ratio?: string;
    duration?: string;
  }[];
  format: { duration: string };
}

async function probeStreams(filePath: string): Promise<ProbedStreams> {
  const { stdout } = await runCommand(config.media.ffprobePath, [
    '-v', 'error',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,display_aspect_ratio,duration:format=duration',
    '-print_format', 'json',
    filePath,
  ]);

  return JSON.parse(stdout) as ProbedStreams;
}

/**
 * Average luma per frame.
 *
 * `signalstats` computes it and `metadata=print` writes it to stdout, so the
 * whole measurement is one FFmpeg pass and no pixels reach this process.
 */
async function frameBrightness(filePath: string): Promise<number[]> {
  const { stdout } = await runCommand(
    config.media.ffmpegPath,
    [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', filePath,
      '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
      '-f', 'null', '-',
    ],
    { timeoutMs: 300_000 },
  );

  return [...stdout.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((match) => Number(match[1]));
}
