/**
 * Minimal RIFF/WAVE reader for the ASR upload path.
 *
 * Riva's `StreamingRecognize` wants raw PCM frames, not a container, so the
 * header has to be located and skipped. Both halves of this file exist to keep
 * the process's memory flat: the header is read from a bounded window at the
 * front of the file, and the samples are handed out as fixed-size chunks from a
 * read stream. An hour of 16 kHz mono PCM is ~115 MB on disk and never more
 * than one chunk in RAM.
 *
 * Deliberately not a general-purpose WAV parser. It reads exactly what
 * `buildExtractAudioArgs` produces — `pcm_s16le`, one `fmt ` chunk, one `data`
 * chunk — and refuses anything else rather than guessing.
 */

import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { mediaError } from '@/lib/errors';

/** WAVE_FORMAT_PCM. Anything else is not raw samples and we will not stream it. */
const WAVE_FORMAT_PCM = 1;

/** Chunk headers live at the front; 64 KB is far more than FFmpeg ever writes. */
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * ~1 second of 16 kHz mono 16-bit audio per message. Small enough that memory
 * stays flat, large enough that a 40-minute file is a few thousand messages
 * rather than a few hundred thousand.
 */
export const PCM_CHUNK_BYTES = 32 * 1024;

export interface WavPcmLayout {
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  /** Byte offset of the first sample. */
  readonly dataOffset: number;
  /**
   * Length of the `data` chunk in bytes, or null when the writer left it
   * unset (streamed output) and the samples run to end of file.
   */
  readonly dataLength: number | null;
}

/**
 * Locate the PCM payload inside a WAV file.
 *
 * @throws AppError kind=media when the file is not PCM WAV
 */
export async function readWavPcmLayout(audioPath: string): Promise<WavPcmLayout> {
  const handle = await open(audioPath, 'r');
  let header: Buffer;
  let fileSize: number;
  try {
    fileSize = (await handle.stat()).size;
    const window = Buffer.alloc(Math.min(MAX_HEADER_BYTES, fileSize));
    const { bytesRead } = await handle.read(window, 0, window.length, 0);
    header = window.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  if (header.length < 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    throw malformed('Not a RIFF/WAVE file.');
  }

  let format: { sampleRateHz: number; channels: number; bitsPerSample: number } | null = null;
  // Chunks follow the 12-byte RIFF header: 4-byte id, 4-byte size, payload,
  // then a pad byte when the size is odd.
  let cursor = 12;

  while (cursor + 8 <= header.length) {
    const id = header.toString('ascii', cursor, cursor + 4);
    const size = header.readUInt32LE(cursor + 4);
    const body = cursor + 8;

    if (id === 'fmt ') {
      if (body + 16 > header.length) throw malformed('Truncated `fmt ` chunk.');
      const audioFormat = header.readUInt16LE(body);
      if (audioFormat !== WAVE_FORMAT_PCM) {
        throw malformed(`Audio is not uncompressed PCM (format tag ${audioFormat}).`);
      }
      format = {
        channels: header.readUInt16LE(body + 2),
        sampleRateHz: header.readUInt32LE(body + 4),
        bitsPerSample: header.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!format) throw malformed('`data` chunk appears before `fmt `.');
      const available = fileSize - body;
      // A streamed writer leaves the size as 0 or 0xFFFFFFFF; either way the
      // samples run to end of file.
      const declared = size === 0 || size === 0xffff_ffff || size > available ? null : size;
      return { ...format, dataOffset: body, dataLength: declared };
    }

    cursor = body + size + (size % 2);
  }

  throw malformed('No `data` chunk found in the first 64 KB.');
}

/**
 * Yield the PCM payload in fixed-size chunks, streamed from disk.
 *
 * The whole point of this generator is that the caller can `for await` over an
 * arbitrarily long recording while only one chunk is resident.
 */
export async function* streamPcmChunks(
  audioPath: string,
  layout: WavPcmLayout,
  chunkBytes: number = PCM_CHUNK_BYTES,
): AsyncGenerator<Uint8Array> {
  const stream = createReadStream(audioPath, {
    start: layout.dataOffset,
    // `end` is inclusive, so the last byte is dataOffset + length - 1.
    ...(layout.dataLength === null ? {} : { end: layout.dataOffset + layout.dataLength - 1 }),
    highWaterMark: chunkBytes,
  });

  try {
    for await (const chunk of stream) {
      // A read stream may hand back less than highWaterMark; Riva accepts any
      // chunk size, so there is nothing to re-align.
      yield chunk as Uint8Array;
    }
  } finally {
    stream.destroy();
  }
}

const malformed = (detail: string) =>
  mediaError('audio_not_pcm_wav', `Extracted audio could not be read as PCM WAV: ${detail}`);
