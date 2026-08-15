import { describe, expect, it } from 'vitest';
import { detectToolchain, parseVersion, pathRedactor, runCommand } from '@/media/ffmpeg';
import { parseFrameRate, parseProbeOutput, type ProbeOutput } from '@/media/probe';
import { FfmpegMediaService } from '@/media/media-service';
import { parseEnv } from '@/config/env';

const config = parseEnv(process.env, process.cwd());

/* -------------------------------------------------------------------------- */
/* FFmpeg detection — runs against the real machine.                          */
/* -------------------------------------------------------------------------- */

describe('FFmpeg detection', () => {
  it('reports a self-consistent status for the configured paths', async () => {
    const status = await detectToolchain(config.media);

    // Whether or not FFmpeg is installed, the report must be coherent.
    for (const binary of [status.ffmpeg, status.ffprobe]) {
      if (binary.available) {
        expect(binary.version).toBeTypeOf('string');
        expect(binary.error).toBeNull();
      } else {
        expect(binary.version).toBeNull();
        expect(binary.error).toBeTypeOf('string');
      }
    }

    expect(status.available).toBe(status.ffmpeg.available && status.ffprobe.available);
    expect(Date.parse(status.checkedAt)).not.toBeNaN();
  });

  it('reports a missing binary instead of throwing', async () => {
    const status = await detectToolchain({
      ffmpegPath: 'ffmpeg-does-not-exist',
      ffprobePath: 'ffprobe-does-not-exist',
    });

    expect(status.available).toBe(false);
    expect(status.ffmpeg.error).toMatch(/not found/i);
  });

  it('raises a media error when a binary is missing', async () => {
    await expect(runCommand('definitely-not-a-binary-xyz', ['-version'])).rejects.toMatchObject({
      kind: 'media',
      code: 'toolchain_missing',
    });
  });

  it('caches the toolchain check once it succeeds', async () => {
    const service = new FfmpegMediaService(config.media);
    const first = await service.toolchain();
    const second = await service.toolchain();

    if (first.available) expect(second).toBe(first);
    else expect(second).not.toBe(first); // keeps re-checking while unavailable
  });
});

describe('pathRedactor', () => {
  it('reduces the absolute paths we passed down to basenames', () => {
    const redact = pathRedactor(['-v', 'error', 'E:\\PROJECTS\\app\\storage\\uploads\\abc__talk.mp4']);

    expect(redact('E:\\PROJECTS\\app\\storage\\uploads\\abc__talk.mp4: Invalid data found')).toBe(
      'abc__talk.mp4: Invalid data found',
    );
  });

  it('handles posix paths and leaves other text alone', () => {
    const redact = pathRedactor(['/srv/app/storage/uploads/clip.mp4']);

    expect(redact('moov atom not found in /srv/app/storage/uploads/clip.mp4')).toBe(
      'moov atom not found in clip.mp4',
    );
    expect(redact('nothing to redact here')).toBe('nothing to redact here');
  });

  it('ignores flags and relative arguments', () => {
    expect(pathRedactor(['-show_format', 'ffprobe'])('-show_format ffprobe')).toBe('-show_format ffprobe');
  });
});

describe('parseVersion', () => {
  it('extracts the version token from a banner', () => {
    expect(parseVersion('ffmpeg version 8.1.1-essentials_build-www.gyan.dev Copyright (c) 2000')).toBe(
      '8.1.1-essentials_build-www.gyan.dev',
    );
    expect(parseVersion('ffprobe version n7.0 Copyright')).toBe('n7.0');
  });

  it('returns null for output it does not recognise', () => {
    expect(parseVersion('bash: ffmpeg: command not found')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Probe parsing — pure, no subprocess.                                       */
/* -------------------------------------------------------------------------- */

describe('parseFrameRate', () => {
  it.each([
    ['30/1', 30],
    ['30000/1001', 29.97],
    ['25', 25],
    ['0/0', null],
    ['0/1', null],
    [undefined, null],
  ])('parses %s', (input, expected) => {
    expect(parseFrameRate(input)).toBe(expected);
  });
});

describe('parseProbeOutput', () => {
  const full: ProbeOutput = {
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
    format: { duration: '612.3456', bit_rate: '4000000', format_name: 'mov,mp4,m4a' },
  };

  it('maps a normal file to MediaMetadata', () => {
    expect(parseProbeOutput(full)).toEqual({
      durationSec: 612.346,
      width: 1920,
      height: 1080,
      fps: 29.97,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      bitrate: 4_000_000,
      containerFormat: 'mov,mp4,m4a',
    });
  });

  it('detects the absence of an audio track', () => {
    const silent = parseProbeOutput({ ...full, streams: [full.streams![0]!] });
    expect(silent.hasAudio).toBe(false);
    expect(silent.audioCodec).toBeNull();
  });

  it('falls back to the stream duration when the container has none', () => {
    const output: ProbeOutput = {
      streams: [{ ...full.streams![0]!, duration: '42' }],
      format: { format_name: 'matroska' },
    };
    expect(parseProbeOutput(output).durationSec).toBe(42);
  });

  it('treats an unreported bitrate as null rather than zero', () => {
    expect(parseProbeOutput({ ...full, format: { duration: '10', format_name: 'webm' } }).bitrate).toBeNull();
  });

  it.each([
    [{ streams: [{ codec_type: 'audio', codec_name: 'mp3' }], format: { duration: '10' } }, 'no_video_stream'],
    [{ streams: [{ codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30/1' }] }, 'unknown_duration'],
    [
      { streams: [{ codec_type: 'video', avg_frame_rate: '30/1' }], format: { duration: '10' } },
      'unknown_resolution',
    ],
    [
      { streams: [{ codec_type: 'video', width: 1920, height: 1080 }], format: { duration: '10' } },
      'unknown_frame_rate',
    ],
  ])('rejects unusable media as %s', (output, code) => {
    expect(() => parseProbeOutput(output as ProbeOutput)).toThrowError(
      expect.objectContaining({ kind: 'media', code }),
    );
  });
});
