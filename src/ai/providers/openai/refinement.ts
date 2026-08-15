/**
 * OpenAI clip-refinement adapter.
 *
 * Sends one already-constructed clip and asks the model to read it: does it
 * stand alone, does it pay off, how much does it lean on context it does not
 * contain. Boundaries are not in the conversation — they were decided by
 * deterministic snapping before this call and cannot be changed by the answer.
 *
 * As with discovery: the response is schema-validated here, and the quote is
 * verified against the clip's own transcript text by the validation layer.
 */

import { z } from 'zod';
import { aiError } from '@/lib/errors';
import type { ClipRefinementCapability, ClipRefinementDraft, ClipRefinementRequest } from '@/ai/types';
import type { OpenAiClient } from './client';
import { extractJsonContent } from './discovery';

const SYSTEM_PROMPT = `You judge whether one short passage of a transcript works as a standalone short video.

You are given the exact text of a clip. Its start and end are already fixed — you cannot change them, and you must not suggest changing them.

Return:
- title: three to eight words describing the clip, in your own words. This is a label shown in a UI, never presented as something the speaker said. Do not put it in quotation marks.
- hook_quote: the single strongest line to open with, copied CHARACTER FOR CHARACTER from the clip text. Do not paraphrase, summarise, correct grammar or fix punctuation. If no line stands out, return an empty string. A quote that does not appear verbatim in the clip text causes your entire response to be discarded.
- curiosity: 0 to 1. Does it open a question a viewer would stay to see answered?
- standalone: 0 to 1. Does it make sense to someone who has seen nothing else from this video?
- payoff: 0 to 1. Does it resolve what it raises, inside the clip?
- context_dependency: 0 to 1, where 1 is worst. How much does it depend on things said elsewhere — unexplained pronouns, references back, mid-argument openings?

Judge only what is in the text. Do not speculate about the video.`;

/** A clip is 30–40s of speech; anything much larger is not a clip. */
const MAX_CLIP_CHARS = 12_000;

const unit = z.number().min(0).max(1);

export const refinementResponseSchema = z.object({
  title: z.string(),
  hook_quote: z.string(),
  curiosity: unit,
  standalone: unit,
  payoff: unit,
  context_dependency: unit,
  notes: z.string().nullish(),
});

/** Sent as `response_format`; `strict` requires every property in `required`. */
export const REFINEMENT_JSON_SCHEMA = {
  name: 'clip_refinement',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'hook_quote', 'curiosity', 'standalone', 'payoff', 'context_dependency', 'notes'],
    properties: {
      title: { type: 'string', description: 'Three to eight words labelling the clip. Never a quote.' },
      hook_quote: {
        type: 'string',
        description: 'A line copied EXACTLY from the clip text, or an empty string.',
      },
      curiosity: { type: 'number', description: 'Does it open a question worth staying for? 0 to 1.' },
      standalone: { type: 'number', description: 'Does it work with no surrounding context? 0 to 1.' },
      payoff: { type: 'number', description: 'Does it resolve what it raises? 0 to 1.' },
      context_dependency: {
        type: 'number',
        description: 'How much it leans on material outside the clip. 0 to 1, higher is worse.',
      },
      notes: { type: ['string', 'null'], description: 'One sentence of reasoning.' },
    },
  },
} as const;

export function createOpenAiRefinement(client: OpenAiClient, model: string): ClipRefinementCapability {
  return {
    async refineClip(request: ClipRefinementRequest): Promise<ClipRefinementDraft> {
      const raw = await client.postJson<unknown>('/chat/completions', {
        model,
        // Refinement feeds a score; it should not wander between runs.
        temperature: 0.1,
        response_format: { type: 'json_schema', json_schema: REFINEMENT_JSON_SCHEMA },
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
