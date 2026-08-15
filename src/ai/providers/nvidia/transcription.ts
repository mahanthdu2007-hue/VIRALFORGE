/**
 * NVIDIA Parakeet transcription adapter.
 *
 * Implements the existing `TranscriptionCapability` unchanged: audio in by
 * path, a `TranscriptionDraft` of timed verbatim segments out. Nothing about
 * the domain types moved to accommodate NVIDIA.
 *
 * Transport is Riva's unary `Recognize` over gRPC — see `riva/transport.ts`
 * for why HTTP is not an option for this model, and why `Recognize` rather
 * than `StreamingRecognize` (the NVCF-hosted function only serves the former).
 * `Recognize` carries its whole request as one `bytes` field, so this adapter
 * is what keeps memory bounded instead: the recording is read from disk in
 * 32 KB pieces, re-batched into a few-minute chunk (`NVIDIA_CHUNK_DURATION_SEC`),
 * sent as one `Recognize` call, and only then is the next chunk read — a
 * 40-minute source costs one chunk of RAM, never the whole file, and never one
 * gRPC message either.
 *
 * Mapping is deliberately literal. Riva's final results become segments, its
 * `WordInfo` entries become `words`, and a field NVIDIA does not send is left
 * off the draft rather than filled with a plausible number. Each chunk's
 * timestamps are relative to that chunk's own audio, not the source, so they
 * are shifted by the chunk's start offset before being merged — see
 * `offsetSegment` below.
 */

import { aiError, isAppError, type AppError } from '@/lib/errors';
import type {
  AudioSpec,
  TranscriptionCapability,
  TranscriptionDraft,
  TranscriptionRequest,
  TranscriptSegmentDraft,
  TranscriptWordDraft,
} from '@/ai/types';
import { readWavPcmLayout, streamPcmChunks } from './wav';
import { batchPcmChunks } from './chunking';
import {
  NVIDIA_ASR_ENDPOINT,
  type RivaAsrTransport,
  type RivaRecognitionConfig,
  type RivaStreamingRequest,
  type RivaStreamingResponse,
} from './riva/transport';

/**
 * Riva wants raw PCM, so this must be the uncompressed spec. 16 kHz mono is
 * what Parakeet is trained on and what the media engine already produces by
 * default; no upload ceiling applies, because nothing is uploaded as a file.
 */
export const NVIDIA_AUDIO_SPEC: AudioSpec = {
  format: 'wav',
  sampleRateHz: 16_000,
  channels: 1,
};

/** Parakeet TDT 0.6B v2 is an English model; NVIDIA documents it as en-US. */
export const NVIDIA_DEFAULT_LANGUAGE = 'en-US';

/**
 * NVCF function ids for the ASR models NVIDIA hosts, from each model's page on
 * build.nvidia.com. The function — not the `model` field — selects the model on
 * the hosted gateway, which is why `RecognitionConfig.model` is left empty.
 * An operator running their own Speech NIM overrides the id in configuration.
 */
export const NVIDIA_ASR_FUNCTION_IDS: Readonly<Record<string, string>> = {
  'nvidia/parakeet-tdt-0.6b-v2': 'd3fe9151-442b-4204-a70d-5fcc597fd610',
};

/** Transcribing 40 minutes of audio legitimately takes minutes. */
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * Longest span of audio sent as one `Recognize` call.
 *
 * NVIDIA's NVCF-hosted Parakeet function only serves the unary `Recognize`
 * RPC (`riva/transport.ts`) — the whole span goes in one `bytes` field of one
 * gRPC message. At this pipeline's audio spec (16 kHz mono, 16-bit PCM) that
 * is 32,000 bytes/sec, so 5 minutes is ~9.6 MB: comfortably under the
 * channel's 64 MB ceiling (`MAX_MESSAGE_BYTES` in `riva/transport.ts`) with
 * headroom for protobuf/gRPC framing, while keeping a 41-minute source to
 * ~9 requests rather than one ~80 MB message that would itself risk
 * `RESOURCE_EXHAUSTED`. Also bounds peak memory: only one chunk is ever
 * resident, regardless of source length.
 */
export const NVIDIA_CHUNK_DURATION_SEC = 5 * 60;

export interface NvidiaTranscriptionOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly endpoint?: string;
  /** Overrides the built-in lookup; required for a model not listed above. */
  readonly functionId?: string;
  readonly timeoutMs?: number;
  /**
   * Overrides `NVIDIA_CHUNK_DURATION_SEC`. Exists so tests can force multiple
   * chunks over a small fixture file instead of writing a real multi-minute
   * one; production never sets this.
   */
  readonly chunkDurationSec?: number;
  /** Injected by tests to exercise the adapter contract without gRPC. */
  readonly transport: RivaAsrTransport;
}

export function createNvidiaTranscription(options: NvidiaTranscriptionOptions): TranscriptionCapability {
  return {
    audioSpec: NVIDIA_AUDIO_SPEC,

    async transcribe(request: TranscriptionRequest): Promise<TranscriptionDraft> {
      if (!options.apiKey) {
        throw aiError('provider_not_configured', 'NVIDIA_API_KEY is required to transcribe.', {
          details: { variable: 'NVIDIA_API_KEY' },
        });
      }

      const functionId = options.functionId ?? NVIDIA_ASR_FUNCTION_IDS[options.model];
      if (!functionId) {
        throw aiError(
          'provider_not_configured',
          `No NVCF function id is known for "${options.model}". Set NVIDIA_ASR_FUNCTION_ID.`,
          { details: { model: options.model, variable: 'NVIDIA_ASR_FUNCTION_ID' } },
        );
      }

      // Read the header before opening the call: a file we cannot parse should
      // fail here, not halfway through a paid request.
      const layout = await readWavPcmLayout(request.audioPath);
      const languageCode = request.languageHint ?? NVIDIA_DEFAULT_LANGUAGE;

      const config: RivaRecognitionConfig = {
        encoding: 'LINEAR_PCM',
        // The file's own rate, not the requested spec: they agree, and trusting
        // the header means a re-encode can never desynchronise the timestamps.
        sample_rate_hertz: layout.sampleRateHz,
        language_code: languageCode,
        max_alternatives: 1,
        audio_channel_count: layout.channels,
        // The whole reason this capability is usable: without it Riva returns
        // text with no timings, and the pipeline has nothing to cut on.
        enable_word_time_offsets: true,
        enable_automatic_punctuation: true,
        // Empty: the NVCF function id already selects Parakeet.
        model: '',
        // Verbatim speech is the contract. Riva must not tidy what was said.
        verbatim_transcripts: true,
      };

      const frameBytes = layout.channels * (layout.bitsPerSample / 8);
      const bytesPerSecond = layout.sampleRateHz * frameBytes;
      const maxChunkBytes = (options.chunkDurationSec ?? NVIDIA_CHUNK_DURATION_SEC) * bytesPerSecond;

      const chunks = batchPcmChunks(streamPcmChunks(request.audioPath, layout), maxChunkBytes, frameBytes);

      const collected: CollectedSegment[] = [];
      let chunkIndex = 0;

      for await (const chunk of chunks) {
        const chunkStartSec = chunk.startByteOffset / bytesPerSecond;
        const chunkEndSec = (chunk.startByteOffset + chunk.byteLength) / bytesPerSecond;

        const responses = options.transport(
          {
            endpoint: options.endpoint ?? NVIDIA_ASR_ENDPOINT,
            metadata: {
              authorization: `Bearer ${options.apiKey}`,
              'function-id': functionId,
            },
            timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          },
          chunkRequests(config, chunk.audio),
        );

        let chunkCollected: readonly CollectedSegment[];
        try {
          chunkCollected = await collectSegments(responses, options.model);
        } catch (error) {
          throw withChunkContext(error, { chunkIndex, chunkStartSec, chunkEndSec });
        }

        for (const item of chunkCollected) {
          collected.push({ segment: offsetSegment(item.segment, chunkStartSec), languageCode: item.languageCode });
        }
        chunkIndex++;
      }

      return {
        // Riva echoes a language only on some models; fall back to what we
        // asked for, which is what it actually ran.
        language: detectedLanguage(collected) ?? languageCode,
        model: options.model,
        segments: collected.map((c) => c.segment),
      };
    },
  };
}

/**
 * One chunk's request stream: a configuration message, then its whole audio
 * buffer as a single `audio_content` message. `Recognize` is unary — the
 * transport concatenates whatever `audio_content` messages it receives into
 * one request field regardless — so there is no benefit to re-splitting a
 * chunk that is already sized to fit in one `Recognize` call.
 */
async function* chunkRequests(config: RivaRecognitionConfig, audio: Uint8Array): AsyncGenerator<RivaStreamingRequest> {
  yield { streaming_config: { config, interim_results: false } };
  yield { audio_content: audio };
}

/**
 * Riva times every result relative to the audio it was actually given — chunk
 * N's timestamps start back at zero, not at the source's N-th minute. Shifting
 * every segment and word by the chunk's own start offset is what makes the
 * merged transcript's timestamps absolute, and is the only thing that needs to
 * happen for chunk boundaries to be invisible in the output: chunks are
 * disjoint byte ranges (`batchPcmChunks` never repeats or skips a byte), so
 * concatenating their offset segments in chunk order can neither duplicate nor
 * drop a moment of the source.
 */
function offsetSegment(segment: TranscriptSegmentDraft, offsetSec: number): TranscriptSegmentDraft {
  if (offsetSec === 0) return segment;
  return {
    ...segment,
    startSec: segment.startSec + offsetSec,
    endSec: segment.endSec + offsetSec,
    ...(segment.words
      ? { words: segment.words.map((w) => ({ ...w, startSec: w.startSec + offsetSec, endSec: w.endSec + offsetSec })) }
      : {}),
  };
}

/**
 * Attach which chunk failed to an error that is otherwise indistinguishable
 * from a single-chunk failure. The original `AppError`'s `kind`/`code` are
 * preserved exactly — this is the same provider error the caller already
 * handles, just with enough context to say *where* in a 40-minute source it
 * broke, since "NVIDIA transcription request failed" alone is useless once a
 * source is nine requests instead of one.
 */
function withChunkContext(
  error: unknown,
  chunk: { readonly chunkIndex: number; readonly chunkStartSec: number; readonly chunkEndSec: number },
): AppError {
  const at = `chunk ${chunk.chunkIndex} (${chunk.chunkStartSec.toFixed(1)}s–${chunk.chunkEndSec.toFixed(1)}s)`;

  if (isAppError(error)) {
    return aiError(error.code, `${error.message} [failed on ${at}]`, {
      cause: error,
      details: { ...error.details, chunk },
      logDetails: { ...error.logDetails, chunk },
    });
  }
  return aiError('provider_unreachable', `NVIDIA transcription failed on ${at}.`, {
    cause: error,
    details: { chunk },
  });
}

interface CollectedSegment {
  readonly segment: TranscriptSegmentDraft;
  readonly languageCode: string | null;
}

/**
 * Turn Riva's final results into segments.
 *
 * Interim results are ignored — they are revised later in the stream, and a
 * transcript assembled from them would contain text that was never said in that
 * form. Only `is_final` is durable.
 */
async function collectSegments(
  responses: AsyncIterable<RivaStreamingResponse>,
  model: string,
): Promise<readonly CollectedSegment[]> {
  const collected: CollectedSegment[] = [];

  try {
    for await (const response of responses) {
      for (const result of response.results ?? []) {
        if (!result.is_final) continue;

        const alternative = result.alternatives?.[0];
        const transcript = alternative?.transcript ?? '';
        // Riva emits empty finals across silence. Nothing was said; nothing to
        // record. The normaliser would drop these anyway.
        if (transcript.trim().length === 0) continue;

        const words = (alternative?.words ?? []).flatMap(toWord);
        if (words.length === 0) {
          // Hard failure by design. Text with no timing cannot be cut into
          // clips, and inventing a span for it would be a fabricated
          // transcript, so the job stops here instead of degrading silently.
          throw aiError(
            'provider_response_invalid',
            'NVIDIA returned transcript text with no word timestamps.',
            { details: { model, transcript: transcript.slice(0, 80) } },
          );
        }

        const confidence = confidenceOf(alternative?.confidence);
        collected.push({
          segment: {
            startSec: words[0]!.startSec,
            endSec: words.at(-1)!.endSec,
            text: transcript,
            ...(confidence === null ? {} : { confidence }),
            words,
          },
          languageCode: alternative?.language_code?.[0] ?? null,
        });
      }
    }
  } catch (error) {
    // Our own errors carry the right code already; anything else came out of
    // the transport and is a provider failure, not an internal one.
    throw isAppError(error)
      ? error
      : aiError('provider_unreachable', 'The NVIDIA transcription stream failed.', { cause: error });
  }

  return collected;
}

/** Riva reports word offsets in milliseconds. A word without them is dropped. */
function toWord(word: { start_time?: number; end_time?: number; word?: string }): TranscriptWordDraft[] {
  const text = word.word ?? '';
  if (text.length === 0) return [];
  if (!Number.isFinite(word.start_time) || !Number.isFinite(word.end_time)) return [];
  return [{ text, startSec: word.start_time! / 1000, endSec: word.end_time! / 1000 }];
}

/**
 * Riva's confidence is model-dependent: some models return a probability,
 * others a log-likelihood or a placeholder zero. Only a value already on the
 * 0..1 scale the domain expects is passed through; anything else is omitted,
 * because a rescaled guess would be a number we made up.
 */
function confidenceOf(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  if (value <= 0 || value > 1) return null;
  return value;
}

/** The language Riva reports, when it reports one. */
const detectedLanguage = (segments: readonly CollectedSegment[]): string | null =>
  segments.find((s) => s.languageCode !== null)?.languageCode ?? null;
