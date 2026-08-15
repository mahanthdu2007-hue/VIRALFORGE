/**
 * End-to-end proof of the reframing seam: a real 16:9 file, rendered through
 * the existing renderer with a centre-crop profile, then read back with
 * ffprobe. The unit tests assert the geometry and the command line; this
 * asserts that FFmpeg actually produces a playable 9:16 clip from them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FfmpegClipRenderer } from '@/media/clip-renderer';
import { FfmpegMediaService } from '@/media/media-service';
import { centerCropProfile } from '@/media/reframe';
import { runCommand } from '@/media/ffmpeg';
import { parseEnv } from '@/config/env';
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
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-reframe-'));
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

describe('centre-cropped render of a real 16:9 source', () => {
  it('produces a playable 1080×1920 clip that keeps its audio in sync', async () => {
    expect(toolchainAvailable, 'FFmpeg is required for this test').toBe(true);

    const outputPath = path.join(workDir, 'clip-9x16.mp4');
    const { profile } = centerCropProfile({ source: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT } });

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
          width: SOURCE_WIDTH,
          height: SOURCE_HEIGHT,
          fps: 25,
          videoCodec: 'h264',
          audioCodec: 'aac',
        }),
      }),
      sourcePath,
      plan: makeClipPlan([CUT], { id: 'reframe-plan-1' as ClipPlanId }),
      outputPath,
      profile,
    });

    // Filtering rules out stream copy; the renderer must have chosen that itself.
    expect(rendered.mode).toBe('reencode');
    expect(rendered.modeReason).toBe('filters_requested');
    expect(rendered.width).toBe(1080);
    expect(rendered.height).toBe(1920);
    expect(rendered.hasAudio).toBe(true);

    const { stdout } = await runCommand(config.media.ffprobePath, [
      '-v', 'error',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,display_aspect_ratio,duration:format=duration',
      '-print_format', 'json',
      outputPath,
    ]);

    const probed = JSON.parse(stdout) as {
      streams: {
        codec_type: string;
        codec_name: string;
        width?: number;
        height?: number;
        display_aspect_ratio?: string;
        duration?: string;
      }[];
      format: { duration: string };
    };

    const video = probed.streams.find((s) => s.codec_type === 'video')!;
    const audio = probed.streams.find((s) => s.codec_type === 'audio')!;

    expect(video.width).toBe(1080);
    expect(video.height).toBe(1920);
    expect(video.width! / video.height!).toBe(SHORTS_ASPECT_RATIO);
    // Square pixels: the frame is 9:16 on screen, not merely in stored samples.
    expect(video.display_aspect_ratio).toBe('9:16');

    expect(audio.codec_name).toBe('aac');
    expect(Number(probed.format.duration)).toBeCloseTo(CUT.endSec - CUT.startSec, 0);
    // Equal-length tracks: cropping the picture did not shift the speech.
    expect(Math.abs(Number(video.duration) - Number(audio.duration))).toBeLessThan(0.1);

    // Playable: decode every packet and require FFmpeg to report nothing.
    const decoded = await runCommand(
      config.media.ffmpegPath,
      ['-nostdin', '-v', 'error', '-i', outputPath, '-f', 'null', '-'],
      { timeoutMs: 300_000 },
    );
    expect(decoded.stderr.trim()).toBe('');
  }, 600_000);
});
