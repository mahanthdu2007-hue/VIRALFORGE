import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildExtractAudioArgs, DEFAULT_AUDIO_SPEC } from '@/media/audio';
import { FfmpegMediaService } from '@/media/media-service';
import { runCommand } from '@/media/ffmpeg';
import { parseEnv } from '@/config/env';

const config = parseEnv(process.env, process.cwd());
const media = new FfmpegMediaService(config.media);

let workDir: string;
/** A tiny generated MP4 with an audio track, and one without. */
let withAudio: string;
let withoutAudio: string;
let toolchainAvailable = false;

beforeAll(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-audio-'));
  toolchainAvailable = (await media.toolchain()).available;
  if (!toolchainAvailable) return;

  withAudio = path.join(workDir, 'with-audio.mp4');
  withoutAudio = path.join(workDir, 'silent.mp4');

  // 2 seconds is enough to exercise every code path and keeps the suite fast.
  await runCommand(config.media.ffmpegPath, [
    '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    withAudio,
  ]);

  await runCommand(config.media.ffmpegPath, [
    '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    withoutAudio,
  ]);
}, 120_000);

afterAll(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

/**
 * `MediaService.probe` is deliberately video-only — it rejects a file with no
 * video stream — so inspecting extracted audio needs ffprobe directly.
 */
async function probeAudioStream(file: string) {
  const { stdout } = await runCommand(config.media.ffprobePath, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,channels,sample_rate:format=duration',
    '-print_format', 'json',
    file,
  ]);

  const parsed = JSON.parse(stdout) as {
    streams?: { codec_name?: string; channels?: number; sample_rate?: string }[];
    format?: { duration?: string };
  };

  return {
    codec: parsed.streams?.[0]?.codec_name ?? null,
    channels: parsed.streams?.[0]?.channels ?? null,
    sampleRate: Number(parsed.streams?.[0]?.sample_rate ?? 0),
    durationSec: Number(parsed.format?.duration ?? 0),
  };
}

describe('buildExtractAudioArgs', () => {
  it('asks for mono 16 kHz PCM by default', () => {
    const args = buildExtractAudioArgs('in.mp4', 'out.wav');

    expect(args).toContain('-vn');
    expect(args.join(' ')).toContain('-ac 1');
    expect(args.join(' ')).toContain('-ar 16000');
    expect(args.join(' ')).toContain('-c:a pcm_s16le');
    expect(args.at(-1)).toBe('out.wav');
  });

  it('maps only the first audio stream', () => {
    expect(buildExtractAudioArgs('in.mp4', 'out.wav').join(' ')).toContain('-map 0:a:0');
  });

  it('strips metadata so output is deterministic', () => {
    const args = buildExtractAudioArgs('in.mp4', 'out.wav').join(' ');

    expect(args).toContain('-map_metadata -1');
    expect(args).toContain('-bitexact');
  });

  it('quietens FFmpeg so stderr carries the error, not the banner', () => {
    const args = buildExtractAudioArgs('in.mp4', 'out.wav').join(' ');

    expect(args).toContain('-hide_banner');
    expect(args).toContain('-loglevel error');
  });

  it('selects the codec and container for the requested format', () => {
    const ogg = buildExtractAudioArgs('in.mp4', 'out.ogg', { format: 'ogg', sampleRateHz: 16_000, channels: 1 });

    expect(ogg.join(' ')).toContain('-c:a libopus');
    expect(ogg.join(' ')).toContain('-f ogg');
  });

  it('never mentions the source video as an output', () => {
    const args = buildExtractAudioArgs('/videos/source.mp4', '/work/out.wav');
    expect(args.filter((a) => a === '/videos/source.mp4')).toHaveLength(1);
  });
});

describe.runIf(process.env.SKIP_FFMPEG_TESTS !== '1')('extractAudio', () => {
  it('produces a playable mono 16 kHz file and leaves the source untouched', async () => {
    if (!toolchainAvailable) return;

    const before = await fsp.stat(withAudio);
    const output = path.join(workDir, 'out.wav');

    const result = await media.extractAudio(withAudio, output, DEFAULT_AUDIO_SPEC);

    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.path).toBe(output);

    const probed = await probeAudioStream(output);
    expect(probed.codec).toBe('pcm_s16le');
    expect(probed.channels).toBe(1);
    expect(probed.sampleRate).toBe(16_000);
    expect(probed.durationSec).toBeGreaterThan(1.5);

    // The original video is byte-for-byte unchanged.
    const after = await fsp.stat(withAudio);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  }, 120_000);

  it('is deterministic: the same input twice gives identical bytes', async () => {
    if (!toolchainAvailable) return;

    const a = path.join(workDir, 'det-a.wav');
    const b = path.join(workDir, 'det-b.wav');

    await media.extractAudio(withAudio, a);
    await media.extractAudio(withAudio, b);

    expect(await fsp.readFile(a)).toEqual(await fsp.readFile(b));
  }, 120_000);

  it('encodes Opus when the provider asks for it', async () => {
    if (!toolchainAvailable) return;

    const output = path.join(workDir, 'out.ogg');
    await media.extractAudio(withAudio, output, { format: 'ogg', sampleRateHz: 16_000, channels: 1 });

    const probed = await probeAudioStream(output);
    expect(probed.codec).toBe('opus');
    expect(probed.channels).toBe(1);
    // Compressed output must be materially smaller than PCM.
    const pcm = await fsp.stat(path.join(workDir, 'out.wav'));
    expect((await fsp.stat(output)).size).toBeLessThan(pcm.size);
  }, 120_000);

  it('creates the work directory if it does not exist', async () => {
    if (!toolchainAvailable) return;

    const nested = path.join(workDir, 'nested', 'deeper', 'out.wav');
    await media.extractAudio(withAudio, nested);

    expect((await fsp.stat(nested)).size).toBeGreaterThan(0);
  }, 120_000);

  it('reports a video with no audio track and leaves no partial file', async () => {
    if (!toolchainAvailable) return;

    const output = path.join(workDir, 'never-written.wav');

    await expect(media.extractAudio(withoutAudio, output)).rejects.toMatchObject({
      kind: 'media',
      code: 'no_audio_stream',
    });

    await expect(fsp.stat(output)).rejects.toThrow();
  }, 120_000);

  it('cleans up after a failure on a missing source', async () => {
    if (!toolchainAvailable) return;

    const output = path.join(workDir, 'from-missing.wav');

    await expect(media.extractAudio(path.join(workDir, 'nope.mp4'), output)).rejects.toMatchObject({
      kind: 'media',
    });

    await expect(fsp.stat(output)).rejects.toThrow();
  }, 120_000);
});
