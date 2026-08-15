/**
 * Audio extraction for transcription.
 *
 * The source video is opened by FFmpeg and read as a stream; nothing is loaded
 * into this process. The video itself is never modified — extraction only ever
 * writes a new file into the work area.
 */

import type { AudioFormat, AudioSpec } from '@/ai/types';

/** Speech recognition gains nothing above 16 kHz mono. */
export const DEFAULT_AUDIO_SPEC: AudioSpec = {
  format: 'wav',
  sampleRateHz: 16_000,
  channels: 1,
};

export const AUDIO_FILE_EXTENSION: Record<AudioFormat, string> = {
  wav: '.wav',
  ogg: '.ogg',
  flac: '.flac',
  mp3: '.mp3',
};

interface CodecChoice {
  readonly codec: string;
  readonly container: string;
  /** Bitrate flag, for lossy codecs only. */
  readonly extra: readonly string[];
}

const CODECS: Record<AudioFormat, CodecChoice> = {
  // Uncompressed: largest, but the safest input for a local ASR model.
  wav: { codec: 'pcm_s16le', container: 'wav', extra: [] },
  // Opus at 24 kbps mono stays intelligible for speech: ~10 MB per hour, which
  // keeps hour-long sources under the upload limits of hosted ASR APIs.
  ogg: { codec: 'libopus', container: 'ogg', extra: ['-b:a', '24k', '-vbr', 'on'] },
  flac: { codec: 'flac', container: 'flac', extra: ['-compression_level', '5'] },
  mp3: { codec: 'libmp3lame', container: 'mp3', extra: ['-b:a', '64k'] },
};

/**
 * Build the FFmpeg argument list for an extraction.
 *
 * Pure, so the exact command is asserted in tests without running FFmpeg.
 *
 * Determinism: `-map_metadata -1` drops container metadata and `-bitexact`
 * suppresses the encoder/version stamp, so the same input and spec always
 * produce byte-identical output.
 */
export function buildExtractAudioArgs(
  sourcePath: string,
  outputPath: string,
  spec: AudioSpec = DEFAULT_AUDIO_SPEC,
): string[] {
  const codec = CODECS[spec.format];

  return [
    '-nostdin',
    '-y',
    // Without these, FFmpeg's version banner is the first thing on stderr and
    // buries the actual error.
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    sourcePath,
    // Drop video and subtitles; take the first audio stream only.
    '-vn',
    '-sn',
    '-dn',
    '-map',
    '0:a:0',
    '-ac',
    String(spec.channels),
    '-ar',
    String(spec.sampleRateHz),
    '-c:a',
    codec.codec,
    ...codec.extra,
    '-map_metadata',
    '-1',
    '-bitexact',
    '-f',
    codec.container,
    outputPath,
  ];
}
