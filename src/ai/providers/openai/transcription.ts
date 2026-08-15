/**
 * OpenAI audio transcription adapter.
 *
 * Uses `verbose_json` with both segment and word granularity, which is what
 * makes word-level timing available. The API returns words as one flat array,
 * so they are re-attached to their segments by time overlap here — the domain
 * never sees the wire shape.
 *
 * Low memory: the audio file is wrapped with `fs.openAsBlob`, so undici streams
 * it off disk instead of the process holding it.
 */

import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { aiError } from '@/lib/errors';
import type {
  AudioSpec,
  TranscriptionCapability,
  TranscriptionDraft,
  TranscriptionRequest,
  TranscriptSegmentDraft,
  TranscriptWordDraft,
} from '@/ai/types';
import type { OpenAiClient } from './client';

/**
 * Opus in Ogg at 24 kbps mono: roughly 10 MB per hour of speech, comfortably
 * under the API's 25 MB upload ceiling for sources of any realistic length.
 */
export const OPENAI_AUDIO_SPEC: AudioSpec = {
  format: 'ogg',
  sampleRateHz: 16_000,
  channels: 1,
  maxBytes: 25 * 1024 * 1024,
};

/** Only the fields we consume. Unknown keys are ignored, not rejected. */
const wordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
});

const segmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  avg_logprob: z.number().optional(),
});

const responseSchema = z.object({
  language: z.string().nullish(),
  duration: z.number().nullish(),
  text: z.string().optional(),
  segments: z.array(segmentSchema).optional(),
  words: z.array(wordSchema).optional(),
});

export function createOpenAiTranscription(client: OpenAiClient, model: string): TranscriptionCapability {
  return {
    audioSpec: OPENAI_AUDIO_SPEC,

    async transcribe(request: TranscriptionRequest): Promise<TranscriptionDraft> {
      const form = new FormData();
      form.set('file', await openAsBlob(request.audioPath), path.basename(request.audioPath));
      form.set('model', model);
      form.set('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
      form.append('timestamp_granularities[]', 'word');
      if (request.languageHint) form.set('language', request.languageHint);

      const raw = await client.postForm<unknown>('/audio/transcriptions', form);

      // Never trust the wire shape, even from a first-party API.
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) {
        throw aiError('provider_response_invalid', 'Transcription response did not match the expected shape.', {
          details: { issues: parsed.error.issues.map((i) => i.path.join('.')) },
        });
      }

      const response = parsed.data;
      const words = (response.words ?? []).map(
        (w): TranscriptWordDraft => ({ text: w.word, startSec: w.start, endSec: w.end }),
      );

      if (!response.segments || response.segments.length === 0) {
        // Silent audio is a legitimate outcome; an empty array says so honestly
        // rather than inventing a segment.
        return { language: response.language ?? null, model, segments: [] };
      }

      const segments = response.segments.map((segment): TranscriptSegmentDraft => {
        const inRange = words.filter((w) => w.startSec < segment.end && w.endSec > segment.start);
        return {
          startSec: segment.start,
          endSec: segment.end,
          text: segment.text,
          ...(segment.avg_logprob === undefined ? {} : { confidence: logprobToConfidence(segment.avg_logprob) }),
          ...(inRange.length > 0 ? { words: inRange } : {}),
        };
      });

      return { language: response.language ?? null, model, segments };
    },
  };
}

/**
 * Whisper reports mean token log-probability, not a probability. Exponentiating
 * gives a usable 0..1 confidence; it is indicative, not calibrated.
 */
export function logprobToConfidence(avgLogprob: number): number {
  if (!Number.isFinite(avgLogprob)) return 0;
  return Math.min(1, Math.max(0, Math.exp(avgLogprob)));
}
