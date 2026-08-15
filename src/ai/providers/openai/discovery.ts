/**
 * OpenAI clip-discovery adapter.
 *
 * Sends the timed transcript and asks for moments back as structured JSON. The
 * prompt tells the model what makes a moment worth clipping and what to avoid,
 * but nothing it returns is trusted: the response is schema-validated here, and
 * every quote is verified against the transcript by the pipeline afterwards.
 */

import { z } from 'zod';
import { aiError } from '@/lib/errors';
import { EMPTY_CLIP_SIGNALS } from '@/domain';
import type { CandidateClipDraft, ClipDiscoveryCapability, ClipDiscoveryRequest } from '@/ai/types';
import type { OpenAiClient } from './client';
import { DISCOVERY_JSON_SCHEMA, discoveryResponseSchema } from './discovery-schema';

const SYSTEM_PROMPT = `You find moments in a transcript that would hold a viewer's attention as a standalone short video.

Look for: strong opening statements, curiosity, emotional intensity, surprising information, genuinely useful information, storytelling, a question followed by its answer, strong opinions, tension and its payoff, memorable lines, and stretches with conversational momentum.

Avoid: greetings, introductions and sign-offs, filler, long pauses, repetition, incomplete thoughts, and anything that only makes sense with context from elsewhere in the video.

Rules you must follow exactly:
- Every moment must lie inside the transcript's time range.
- hook_quote must be copied CHARACTER FOR CHARACTER from the transcript. Do not paraphrase, summarise, correct grammar, or fix punctuation. A quote that does not appear verbatim in the transcript causes the whole moment to be discarded.
- topic and reason are your own words describing the moment. They are never presented as speech.
- Prefer moments between {min} and {max} seconds long.
- Return the strongest moments only. Returning fewer than asked is better than padding with weak ones. If nothing qualifies, return an empty list.`;

/** Guards the request body: transcripts of long videos are large. */
const MAX_TRANSCRIPT_CHARS = 240_000;

export function createOpenAiDiscovery(client: OpenAiClient, model: string): ClipDiscoveryCapability {
  return {
    async discoverClips(request: ClipDiscoveryRequest): Promise<readonly CandidateClipDraft[]> {
      if (request.segments.length === 0) return [];

      const system = SYSTEM_PROMPT.replace('{min}', String(request.targetDurationSec.min)).replace(
        '{max}',
        String(request.targetDurationSec.max),
      );

      const raw = await client.postJson<unknown>('/chat/completions', {
        model,
        // Deterministic-leaning: discovery should not shuffle between runs.
        temperature: 0.2,
        response_format: { type: 'json_schema', json_schema: DISCOVERY_JSON_SCHEMA },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: buildUserMessage(request) },
        ],
      });

      const parsed = discoveryResponseSchema.safeParse(extractJsonContent(raw));
      if (!parsed.success) {
        throw aiError('provider_response_invalid', 'Discovery response did not match the expected schema.', {
          details: {
            issues: parsed.error.issues.slice(0, 10).map((i) => ({
              field: i.path.join('.'),
              problem: i.message,
            })),
          },
        });
      }

      return parsed.data.moments.slice(0, request.maxCandidates).map(
        (moment): CandidateClipDraft => ({
          startSec: moment.start_sec,
          endSec: moment.end_sec,
          hookQuote: moment.hook_quote.trim() || null,
          topic: moment.topic.trim() || null,
          reason: moment.reason.trim(),
          confidence: moment.confidence,
          signals: {
            ...EMPTY_CLIP_SIGNALS,
            strongOpening: moment.signals.strong_opening,
            questionAnswered: moment.signals.question_answered,
            strongOpinion: moment.signals.strong_opinion,
            surprise: moment.signals.surprise,
            story: moment.signals.story,
            payoff: moment.signals.payoff,
            emotionalIntensity: moment.signals.emotional_intensity,
            informationDensity: moment.signals.information_density,
            standalone: moment.signals.standalone,
          },
        }),
      );
    },
  };
}

/** Timed transcript, one line per segment, so the model can cite timestamps. */
function buildUserMessage(request: ClipDiscoveryRequest): string {
  const lines = request.segments.map(
    (s) => `[${s.startSec.toFixed(2)} - ${s.endSec.toFixed(2)}] ${s.text.trim()}`,
  );

  let transcript = lines.join('\n');
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n[transcript truncated]`;
  }

  return [
    `Video duration: ${request.videoDurationSec.toFixed(2)} seconds.`,
    `Return at most ${request.maxCandidates} moments.`,
    request.languageHint ? `Language: ${request.languageHint}.` : null,
    '',
    'Transcript:',
    transcript,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

const completionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }), finish_reason: z.string().nullish() }))
    .min(1),
});

/**
 * Pull the JSON payload out of a chat completion.
 * @throws AppError kind=ai when the model returned no content or invalid JSON
 */
export function extractJsonContent(raw: unknown): unknown {
  const parsed = completionSchema.safeParse(raw);
  if (!parsed.success) {
    throw aiError('provider_response_invalid', 'Chat completion had no usable choice.');
  }

  const choice = parsed.data.choices[0]!;
  if (choice.finish_reason === 'length') {
    throw aiError('provider_response_truncated', 'The model hit its output limit before finishing the JSON.');
  }

  const content = choice.message.content;
  if (content === null || content.trim() === '') {
    throw aiError('provider_response_empty', 'The model returned no content.');
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw aiError('provider_response_unparseable', 'The model returned content that is not valid JSON.', {
      cause: error,
      logDetails: { content: content.slice(0, 2000) },
    });
  }
}
