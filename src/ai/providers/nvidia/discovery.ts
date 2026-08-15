/**
 * NVIDIA clip-discovery adapter.
 *
 * Same contract as the OpenAI adapter — same request shape in, same
 * `CandidateClipDraft[]` out, same `discoveryResponseSchema` doing the
 * validation — but no `response_format` is sent: NVIDIA's endpoint does not
 * advertise structured-output support for this model, so the JSON shape is
 * requested in plain text instead and re-checked here exactly as strictly as
 * the OpenAI path checks it.
 */

import { aiError } from '@/lib/errors';
import { EMPTY_CLIP_SIGNALS } from '@/domain';
import type { CandidateClipDraft, ClipDiscoveryCapability, ClipDiscoveryRequest } from '@/ai/types';
import type { OpenAiClient } from '../openai/client';
import { extractJsonContent } from '../openai/discovery';
import { discoveryResponseSchema } from '../openai/discovery-schema';

const SYSTEM_PROMPT = `You find moments in a transcript that would hold a viewer's attention as a standalone short video.

Look for: strong opening statements, curiosity, emotional intensity, surprising information, genuinely useful information, storytelling, a question followed by its answer, strong opinions, tension and its payoff, memorable lines, and stretches with conversational momentum.

Avoid: greetings, introductions and sign-offs, filler, long pauses, repetition, incomplete thoughts, and anything that only makes sense with context from elsewhere in the video.

Cover distinct moments. Several near-duplicates of the same moment with slightly different boundaries crowd out the rest of the video: if two candidates would leave a viewer with essentially the same thing, return only the stronger one, and spend the remaining slots elsewhere in the transcript.

Rules you must follow exactly:
- Every moment must lie inside the transcript's time range.
- hook_quote must be copied CHARACTER FOR CHARACTER from the transcript. Do not paraphrase, summarise, correct grammar, or fix punctuation. A quote that does not appear verbatim in the transcript causes the whole moment to be discarded.
- topic and reason are your own words describing the moment. They are never presented as speech.
- Prefer moments between {min} and {max} seconds long.
- Return the strongest moments only. Returning fewer than asked is better than padding with weak ones. If nothing qualifies, return an empty list.

Respond with a single JSON object and nothing else: no markdown code fences, no headings, no commentary before or after it. It must match exactly this shape:
{
  "moments": [
    {
      "start_sec": <number, seconds on the source timeline>,
      "end_sec": <number, seconds on the source timeline>,
      "hook_quote": <string, verbatim from the transcript, or "">,
      "topic": <string, three to six words>,
      "reason": <string, one sentence>,
      "confidence": <number 0 to 1>,
      "signals": {
        "strong_opening": <boolean>,
        "question_answered": <boolean>,
        "strong_opinion": <boolean>,
        "surprise": <boolean>,
        "story": <boolean>,
        "payoff": <boolean>,
        "emotional_intensity": <number 0 to 1>,
        "information_density": <number 0 to 1>,
        "standalone": <number 0 to 1>
      }
    }
  ]
}
If nothing qualifies, respond with {"moments": []}.`;

/** Guards the request body: transcripts of long videos are large. */
const MAX_TRANSCRIPT_CHARS = 240_000;

export function createNvidiaDiscovery(client: OpenAiClient, model: string): ClipDiscoveryCapability {
  return {
    async discoverClips(request: ClipDiscoveryRequest): Promise<readonly CandidateClipDraft[]> {
      if (request.segments.length === 0) return [];

      const system = SYSTEM_PROMPT.replace('{min}', String(request.targetDurationSec.min)).replace(
        '{max}',
        String(request.targetDurationSec.max),
      );

      // Streamed, not because anything downstream consumes tokens as they
      // arrive — the deltas are reassembled into one completion before this
      // line returns — but because a long non-streaming generation is cut off
      // by NVIDIA's gateway deadline with an HTTP 504 while the model is still
      // writing. Streaming keeps bytes flowing, so the deadline is never hit.
      const raw = await client.postJsonStream<unknown>('/chat/completions', {
        model,
        // Deterministic-leaning: discovery should not shuffle between runs.
        temperature: 0.2,
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
