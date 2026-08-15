/**
 * Contract for discovery output.
 *
 * Two layers, deliberately: the JSON Schema constrains what the model may emit,
 * and the Zod schema re-checks what actually arrived. Structured output is a
 * strong hint, not a guarantee, so nothing is trusted until it parses here.
 */

import { z } from 'zod';

const unit = z.number().min(0).max(1);

export const discoveryCandidateSchema = z.object({
  start_sec: z.number().nonnegative(),
  end_sec: z.number().positive(),
  hook_quote: z.string(),
  topic: z.string(),
  reason: z.string(),
  confidence: unit,
  signals: z.object({
    strong_opening: z.boolean(),
    question_answered: z.boolean(),
    strong_opinion: z.boolean(),
    surprise: z.boolean(),
    story: z.boolean(),
    payoff: z.boolean(),
    emotional_intensity: unit,
    information_density: unit,
    standalone: unit,
  }),
});

export const discoveryResponseSchema = z.object({
  moments: z.array(discoveryCandidateSchema),
});

export type DiscoveryResponse = z.infer<typeof discoveryResponseSchema>;

/**
 * JSON Schema sent as `response_format`. Must stay in step with the Zod schema
 * above; `strict` mode requires every property to appear in `required`.
 */
export const DISCOVERY_JSON_SCHEMA = {
  name: 'viral_moments',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['moments'],
    properties: {
      moments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['start_sec', 'end_sec', 'hook_quote', 'topic', 'reason', 'confidence', 'signals'],
          properties: {
            start_sec: { type: 'number', description: 'Start on the source timeline, in seconds.' },
            end_sec: { type: 'number', description: 'End on the source timeline, in seconds.' },
            hook_quote: {
              type: 'string',
              description:
                'A sentence copied EXACTLY from the transcript that opens the moment. Never paraphrase, never rewrite.',
            },
            topic: { type: 'string', description: 'Three to six words naming the subject.' },
            reason: { type: 'string', description: 'One sentence on why this moment holds attention.' },
            confidence: { type: 'number', description: 'Confidence in this moment, 0 to 1.' },
            signals: {
              type: 'object',
              additionalProperties: false,
              required: [
                'strong_opening',
                'question_answered',
                'strong_opinion',
                'surprise',
                'story',
                'payoff',
                'emotional_intensity',
                'information_density',
                'standalone',
              ],
              properties: {
                strong_opening: { type: 'boolean' },
                question_answered: { type: 'boolean' },
                strong_opinion: { type: 'boolean' },
                surprise: { type: 'boolean' },
                story: { type: 'boolean' },
                payoff: { type: 'boolean' },
                emotional_intensity: { type: 'number' },
                information_density: { type: 'number' },
                standalone: { type: 'number' },
              },
            },
          },
        },
      },
    },
  },
} as const;
