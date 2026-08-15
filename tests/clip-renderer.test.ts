import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FfmpegClipRenderer, validateCuts, type ClipRenderRequest } from '@/media/clip-renderer';
import { FfmpegMediaService } from '@/media/media-service';
import { runCommand } from '@/media/ffmpeg';
import { parseEnv } from '@/config/env';
import type { ClipCut, ClipPlan, ClipPlanId, VideoAsset } from '@/domain';
import { makeClipPlan, makeVideoAsset, makeMetadata } from './helpers/fixtures';

const config = parseEnv(process.env, process.cwd());
const media = new FfmpegMediaService(config.media);

let workDir: string;
/** A 60s MP4 with video and audio — long enough to hold a real 15–55s clip. */
let sourcePath: string;
/** The same, with no audio track. */
let silentPath: string;
/** A file that is not media at all, for the FFmpeg-failure path. */
let corruptPath: string;
let toolchainAvailable = false;

const SOURCE_DURATION_SEC = 60;

beforeAll(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-render-'));
  toolchainAvailable = (await media.toolchain()).available;
  if (!toolchainAvailable) return;

  sourcePath = path.join(workDir, 'source.mp4');
  silentPath = path.join(workDir, 'silent.mp4');
  corruptPath = path.join(workDir, 'corrupt.mp4');

  // A keyframe every 2s (-g 20 at 10fps) gives the stream-copy path something
  // to land on, and the counter in `testsrc` makes a wrong cut visible.
  await runCommand(
    config.media.ffmpegPath,
    [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=10:duration=${SOURCE_DURATION_SEC}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SOURCE_DURATION_SEC}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      sourcePath,
    ],
    { timeoutMs: 180_000 },
  );

  await runCommand(
    config.media.ffmpegPath,
    [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=40',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-pix_fmt', 'yuv420p',
      silentPath,
    ],
    { timeoutMs: 180_000 },
  );

  await fsp.writeFile(corruptPath, 'this is not a video file');
}, 240_000);

afterAll(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const makeSource = (overrides: Partial<VideoAsset> = {}): VideoAsset =>
  makeVideoAsset({
    metadata: makeMetadata({
      durationSec: SOURCE_DURATION_SEC,
      width: 320,
      height: 240,
      fps: 10,
      videoCodec: 'h264',
      audioCodec: 'aac',
    }),
    ...overrides,
  });

const makePlan = (cuts: readonly ClipCut[]): ClipPlan =>
  makeClipPlan(cuts, { id: 'render-plan-1' as ClipPlanId });

const renderer = (options: { enforceDurationLimits?: boolean } = {}) =>
  new FfmpegClipRenderer({
    ffmpegPath: config.media.ffmpegPath,
    ffprobePath: config.media.ffprobePath,
    media,
    commandTimeoutMs: 180_000,
    ...options,
  });

const request = (overrides: Partial<ClipRenderRequest> = {}): ClipRenderRequest => ({
  source: makeSource(),
  sourcePath,
  plan: makePlan([{ order: 0, startSec: 10, endSec: 40 }]),
  outputPath: path.join(workDir, `out-${Math.random().toString(36).slice(2)}.mp4`),
  ...overrides,
});

/** Streams and duration of a rendered file, read back with ffprobe. */
async function probeStreams(file: string) {
  const { stdout } = await runCommand(config.media.ffprobePath, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,duration:format=duration',
    '-print_format', 'json',
    file,
  ]);

  const parsed = JSON.parse(stdout) as {
    streams?: { codec_type?: string; codec_name?: string; duration?: string }[];
    format?: { duration?: string };
  };

  const streams = parsed.streams ?? [];
  return {
    durationSec: Number(parsed.format?.duration ?? 0),
    video: streams.find((s) => s.codec_type === 'video') ?? null,
    audio: streams.find((s) => s.codec_type === 'audio') ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Cut validation — pure, no subprocess.                                      */
/* -------------------------------------------------------------------------- */

describe('validateCuts', () => {
  const plan = (cuts: readonly ClipCut[]) => ({ id: 'p1' as ClipPlanId, cuts });

  it('accepts a well-formed single cut and returns it', () => {
    const cuts = [{ order: 0, startSec: 10, endSec: 40 }];
    expect(validateCuts(plan(cuts), SOURCE_DURATION_SEC)).toEqual(cuts);
  });

  it('returns cuts sorted by order, not by arrival', () => {
    const sorted = validateCuts(
      plan([
        { order: 1, startSec: 30, endSec: 45 },
        { order: 0, startSec: 0, endSec: 20 },
      ]),
      SOURCE_DURATION_SEC,
    );
    expect(sorted.map((c) => c.startSec)).toEqual([0, 30]);
  });

  it('rejects a plan with no cuts', () => {
    expect(() => validateCuts(plan([]), SOURCE_DURATION_SEC)).toThrowError(
      expect.objectContaining({ kind: 'validation', code: 'no_cuts' }),
    );
  });

  it.each([
    [{ order: 0, startSec: 40, endSec: 10 }],
    [{ order: 0, startSec: 20, endSec: 20 }],
    [{ order: 0, startSec: -5, endSec: 30 }],
    [{ order: 0, startSec: Number.NaN, endSec: 30 }],
    [{ order: 0, startSec: 10, endSec: Infinity }],
  ])('rejects the invalid range %j', (cut) => {
    expect(() => validateCuts(plan([cut]), SOURCE_DURATION_SEC)).toThrowError(
      expect.objectContaining({ kind: 'validation', code: 'invalid_cut_range' }),
    );
  });

  it('rejects a cut running past the end of the source', () => {
    expect(() =>
      validateCuts(plan([{ order: 0, startSec: 40, endSec: 90 }]), SOURCE_DURATION_SEC),
    ).toThrowError(expect.objectContaining({ code: 'cut_outside_source' }));
  });

  it('tolerates a marginal float overshoot of the source duration', () => {
    expect(() =>
      validateCuts(plan([{ order: 0, startSec: 20, endSec: 60.01 }]), SOURCE_DURATION_SEC),
    ).not.toThrow();
  });

  it('rejects overlapping cuts, which would repeat speech', () => {
    expect(() =>
      validateCuts(
        plan([
          { order: 0, startSec: 0, endSec: 25 },
          { order: 1, startSec: 20, endSec: 45 },
        ]),
        SOURCE_DURATION_SEC,
      ),
    ).toThrowError(expect.objectContaining({ code: 'cuts_overlap' }));
  });

  it.each([
    [{ order: 0, startSec: 0, endSec: 5 }],
    [{ order: 0, startSec: 0, endSec: 58 }],
  ])('rejects %j as an out-of-limits clip duration', (cut) => {
    expect(() => validateCuts(plan([cut]), SOURCE_DURATION_SEC)).toThrowError(
      expect.objectContaining({ code: 'invalid_clip_duration' }),
    );
  });

  it('sums the cuts when checking the duration limits', () => {
    // 10s + 10s = 20s total, inside the limits, though neither cut is alone.
    expect(() =>
      validateCuts(
        plan([
          { order: 0, startSec: 0, endSec: 10 },
          { order: 1, startSec: 20, endSec: 30 },
        ]),
        SOURCE_DURATION_SEC,
      ),
    ).not.toThrow();
  });

  it('can have the duration limits waived', () => {
    expect(() =>
      validateCuts(plan([{ order: 0, startSec: 0, endSec: 2 }]), SOURCE_DURATION_SEC, false),
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering — real FFmpeg.                                                   */
/* -------------------------------------------------------------------------- */

describe.runIf(process.env.SKIP_FFMPEG_TESTS !== '1')('FfmpegClipRenderer', () => {
  it('renders a valid clip with video, audio and the planned duration', async () => {
    if (!toolchainAvailable) return;

    const req = request({ plan: makePlan([{ order: 0, startSec: 10, endSec: 40 }]) });
    const result = await renderer().render(req);

    expect(result.path).toBe(req.outputPath);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.cutCount).toBe(1);

    // Duration is measured off the output, not copied from the plan.
    expect(result.durationSec).toBeGreaterThan(29.5);
    expect(result.durationSec).toBeLessThan(30.5);

    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
    expect(result.hasAudio).toBe(true);
    expect(result.videoCodec).toBe('h264');
    expect(result.audioCodec).toBe('aac');
    expect(Date.parse(result.renderedAt)).not.toBeNaN();

    const probed = await probeStreams(req.outputPath);
    expect(probed.video).not.toBeNull();
    expect(probed.audio).not.toBeNull();
  }, 240_000);

  it('leaves the source byte-for-byte unchanged', async () => {
    if (!toolchainAvailable) return;

    const before = await fsp.stat(sourcePath);
    await renderer().render(request());
    const after = await fsp.stat(sourcePath);

    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  }, 240_000);

  it('keeps audio and video the same length, so the clip stays in sync', async () => {
    if (!toolchainAvailable) return;

    const req = request({ plan: makePlan([{ order: 0, startSec: 12.5, endSec: 45 }]) });
    await renderer().render(req);

    const { stdout } = await runCommand(config.media.ffprobePath, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,duration',
      '-print_format', 'json',
      req.outputPath,
    ]);
    const streams = (JSON.parse(stdout) as { streams?: { codec_type?: string; duration?: string }[] }).streams ?? [];

    const video = Number(streams.find((s) => s.codec_type === 'video')?.duration ?? 0);
    const audio = Number(streams.find((s) => s.codec_type === 'audio')?.duration ?? 0);

    expect(video).toBeGreaterThan(0);
    expect(audio).toBeGreaterThan(0);
    // Drift beyond a tenth of a second would be audible against the picture.
    expect(Math.abs(video - audio)).toBeLessThan(0.1);
  }, 240_000);

  it('re-encodes rather than drifting when the start is not on a keyframe', async () => {
    if (!toolchainAvailable) return;

    // Keyframes sit every 2s; 17.3 is deliberately between two of them.
    const req = request({ plan: makePlan([{ order: 0, startSec: 17.3, endSec: 50 }]) });
    const result = await renderer().render(req);

    expect(result.mode).toBe('reencode');
    expect(result.modeReason).toBe('start_not_on_keyframe');
    expect(result.durationSec).toBeGreaterThan(32.2);
    expect(result.durationSec).toBeLessThan(32.9);
  }, 240_000);

  it('copies packets when the start lands exactly on a keyframe', async () => {
    if (!toolchainAvailable) return;

    // -g 20 at 10fps puts a keyframe on every even second.
    const req = request({ plan: makePlan([{ order: 0, startSec: 20, endSec: 52 }]) });
    const result = await renderer().render(req);

    expect(result.mode).toBe('stream_copy');
    expect(result.durationSec).toBeGreaterThan(31.5);
    expect(result.durationSec).toBeLessThan(32.5);
  }, 240_000);

  it('renders a silent source without an audio track', async () => {
    if (!toolchainAvailable) return;

    const req = request({
      sourcePath: silentPath,
      source: makeSource({
        metadata: makeMetadata({
          durationSec: 40,
          width: 320,
          height: 240,
          fps: 10,
          hasAudio: false,
          videoCodec: 'h264',
          audioCodec: null,
        }),
      }),
      plan: makePlan([{ order: 0, startSec: 5, endSec: 35 }]),
    });

    const result = await renderer().render(req);
    expect(result.hasAudio).toBe(false);
    expect(result.durationSec).toBeGreaterThan(29.5);
  }, 240_000);

  it('joins a multi-cut plan into one continuous file', async () => {
    if (!toolchainAvailable) return;

    const req = request({
      plan: makePlan([
        { order: 0, startSec: 4, endSec: 20 },
        { order: 1, startSec: 30, endSec: 44 },
      ]),
    });

    const result = await renderer().render(req);

    expect(result.cutCount).toBe(2);
    // 16s + 14s, allowing for frame-boundary rounding at each join.
    expect(result.durationSec).toBeGreaterThan(29);
    expect(result.durationSec).toBeLessThan(31);

    const probed = await probeStreams(req.outputPath);
    expect(probed.audio).not.toBeNull();
  }, 240_000);

  /* -- Failure paths ------------------------------------------------------- */

  it('reports a missing source without running FFmpeg', async () => {
    if (!toolchainAvailable) return;

    await expect(
      renderer().render(request({ sourcePath: path.join(workDir, 'does-not-exist.mp4') })),
    ).rejects.toMatchObject({ kind: 'media', code: 'source_missing' });
  }, 240_000);

  it('reports an empty source file', async () => {
    if (!toolchainAvailable) return;

    const empty = path.join(workDir, 'empty.mp4');
    await fsp.writeFile(empty, '');

    await expect(renderer().render(request({ sourcePath: empty }))).rejects.toMatchObject({
      kind: 'media',
      code: 'source_empty',
    });
  }, 240_000);

  it('rejects an invalid range before touching the filesystem', async () => {
    if (!toolchainAvailable) return;

    const req = request({ plan: makePlan([{ order: 0, startSec: 40, endSec: 10 }]) });

    await expect(renderer().render(req)).rejects.toMatchObject({
      kind: 'validation',
      code: 'invalid_cut_range',
    });
    await expect(fsp.stat(req.outputPath)).rejects.toThrow();
  }, 240_000);

  it('rejects a cut that runs past the end of the source', async () => {
    if (!toolchainAvailable) return;

    await expect(
      renderer().render(request({ plan: makePlan([{ order: 0, startSec: 40, endSec: 95 }]) })),
    ).rejects.toMatchObject({ kind: 'validation', code: 'cut_outside_source' });
  }, 240_000);

  it('surfaces an FFmpeg failure as a rendering error and writes no output', async () => {
    if (!toolchainAvailable) return;

    // A real file, but not decodable media: FFmpeg exits non-zero.
    const req = request({
      sourcePath: corruptPath,
      source: makeSource({ metadata: makeMetadata({ durationSec: SOURCE_DURATION_SEC }) }),
    });

    await expect(renderer().render(req)).rejects.toMatchObject({
      kind: 'rendering',
      code: 'render_failed',
    });
    await expect(fsp.stat(req.outputPath)).rejects.toThrow();
  }, 240_000);

  it('reports a missing FFmpeg binary as a toolchain fault, not a bad clip', async () => {
    if (!toolchainAvailable) return;

    const broken = new FfmpegClipRenderer({
      ffmpegPath: 'ffmpeg-does-not-exist-xyz',
      ffprobePath: config.media.ffprobePath,
      media,
    });

    await expect(broken.render(request())).rejects.toMatchObject({
      kind: 'media',
      code: 'toolchain_missing',
    });
  }, 240_000);

  /* -- Temporary files ----------------------------------------------------- */

  it('leaves no temporary directory behind after a success', async () => {
    if (!toolchainAvailable) return;

    const outputDir = await fsp.mkdtemp(path.join(workDir, 'clean-ok-'));
    await renderer().render(request({ outputPath: path.join(outputDir, 'clip.mp4') }));

    expect(await fsp.readdir(outputDir)).toEqual(['clip.mp4']);
  }, 240_000);

  it('leaves no temporary directory behind after a failure', async () => {
    if (!toolchainAvailable) return;

    const outputDir = await fsp.mkdtemp(path.join(workDir, 'clean-fail-'));

    await expect(
      renderer().render(
        request({ sourcePath: corruptPath, outputPath: path.join(outputDir, 'clip.mp4') }),
      ),
    ).rejects.toThrow();

    // Neither a staged output nor a `.render-*` scratch directory survives.
    expect(await fsp.readdir(outputDir)).toEqual([]);
  }, 240_000);

  it('cleans up the segment directory of a failed multi-cut render', async () => {
    if (!toolchainAvailable) return;

    const outputDir = await fsp.mkdtemp(path.join(workDir, 'clean-multi-'));

    await expect(
      renderer().render(
        request({
          sourcePath: corruptPath,
          outputPath: path.join(outputDir, 'clip.mp4'),
          plan: makePlan([
            { order: 0, startSec: 4, endSec: 20 },
            { order: 1, startSec: 30, endSec: 44 },
          ]),
        }),
      ),
    ).rejects.toThrow();

    expect(await fsp.readdir(outputDir)).toEqual([]);
  }, 240_000);

  it('creates the output directory when it does not exist', async () => {
    if (!toolchainAvailable) return;

    const nested = path.join(workDir, 'nested', 'deeper', 'clip.mp4');
    const result = await renderer().render(request({ outputPath: nested }));

    expect(result.sizeBytes).toBeGreaterThan(0);
  }, 240_000);

  it('probes the source for its duration when the asset carries no metadata', async () => {
    if (!toolchainAvailable) return;

    const result = await renderer().render(request({ source: makeSource({ metadata: null }) }));
    expect(result.durationSec).toBeGreaterThan(29.5);
  }, 240_000);
});
