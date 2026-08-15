/**
 * NVIDIA clip-refinement adapter.
 *
 * Same contract as the OpenAI adapter — same `refinementResponseSchema` doing
 * the validation, same "boundaries are fixed" constraint — but, as with
 * discovery, no `response_format` is sent: the required JSON shape is spelled
 * out in the prompt and the reply is parsed and validated as untrusted text.
 */

import { aiError } from '@/lib/errors';
import type { ClipRefinementCapability, ClipRefinementDraft, ClipRefinementRequest } from '@/ai/types';
import type { OpenAiClient } from '../openai/client';
import { extractJsonContent } from '../openai/discovery';
import { refinementResponseSchema } from '../openai/refinement';

const SYSTEM_PROMPT = `You judge whether one short passage of a transcript works as a standalone short video.

You are given the exact text of a clip. Its start and end are already fixed — you cannot change them, and you must not suggest changing them.

Judge only what is in the text. Do not speculate about the video.

Respond with a single JSON object and nothing else: no markdown code fences, no headings, no commentary before or after it. It must match exactly this shape:
{
  "title": <string, three to eight words describing the clip, your own words, never in quotation marks>,
  "hook_quote": <string, the single strongest line to open with, copied CHARACTER FOR CHARACTER from the clip text, or "" if none stands out>,
  "curiosity": <number 0 to 1, does it open a question a viewer would stay to see answered?>,
  "standalone": <number 0 to 1, does it make sense to someone who has seen nothing else from this video?>,
  "payoff": <number 0 to 1, does it resolve what it raises, inside the clip?>,
  "context_dependency": <number 0 to 1 where 1 is worst, how much does it depend on things said elsewhere?>,
  "notes": <string, one sentence of reasoning, or null>
}
A hook_quote that does not appear verbatim in the clip text causes your entire response to be discarded.`;

/** A clip is 30–40s of speech; anything much larger is not a clip. */
const MAX_CLIP_CHARS = 12_000;

export function createNvidiaRefinement(client: OpenAiClient, model: string): ClipRefinementCapability {
  return {
    async refineClip(request: ClipRefinementRequest): Promise<ClipRefinementDraft> {
      const raw = await client.postJson<unknown>('/chat/completions', {
        model,
        // Refinement feeds a score; it should not wander between runs.
        temperature: 0.1,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(request) },
        ],
      });

      const parsed = refinementResponseSchema.safeParse(extractJsonContent(raw));
      if (!parsed.success) {
        throw aiError('provider_response_invalid', 'Refinement response did not match the expected schema.', {
          details: {
            issues: parsed.error.issues
              .slice(0, 10)
              .map((i) => ({ field: i.path.join('.'), problem: i.message })),
          },
        });
      }

      const value = parsed.data;
      return {
        title: value.title,
        hookQuote: value.hook_quote.trim() || null,
        curiosity: value.curiosity,
        standalone: value.standalone,
        payoff: value.payoff,
        contextDependency: value.context_dependency,
        notes: value.notes ?? null,
      };
    },
  };
}

function buildUserMessage(request: ClipRefinementRequest): string {
  const text =
    request.clipText.length > MAX_CLIP_CHARS
      ? `${request.clipText.slice(0, MAX_CLIP_CHARS)}\n[clip text truncated]`
      : request.clipText;

  return [
    `Clip runs from ${request.startSec.toFixed(2)}s to ${request.endSec.toFixed(2)}s of the source video.`,
    request.topic ? `Suggested subject: ${request.topic}.` : null,
    request.languageHint ? `Language: ${request.languageHint}.` : null,
    '',
    'Clip text:',
    text,
  ]
    .filter((line) => line !== null)
    .join('\n');
}
