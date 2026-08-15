/**
 * OpenAI provider.
 *
 * Assembled from two independent adapters so a future provider can implement
 * one capability without the other. Construction never throws on a missing key:
 * an unconfigured provider reports itself unhealthy, and only fails when a
 * capability is actually invoked.
 */

import { aiError } from '@/lib/errors';
import type { AppConfig } from '@/config/env';
import type { AiProvider, ProviderHealth } from '@/ai/types';
import { OpenAiClient, type FetchLike } from './client';
import { createOpenAiTranscription } from './transcription';
import { createOpenAiDiscovery } from './discovery';
import { createOpenAiRefinement } from './refinement';

export { OPENAI_AUDIO_SPEC } from './transcription';

export interface OpenAiProviderOptions {
  readonly apiKey: string;
  readonly transcriptionModel: string;
  readonly discoveryModel: string;
  readonly baseUrl?: string;
  /** Injected by tests to exercise the adapter contract without network access. */
  readonly fetchImpl?: FetchLike;
}

export function createOpenAiProvider(options: OpenAiProviderOptions): AiProvider {
  const client = new OpenAiClient({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  return {
    id: 'openai',
    displayName: `OpenAI (${options.transcriptionModel} / ${options.discoveryModel})`,
    capabilities: ['transcription', 'clip-discovery', 'clip-refinement'],

    async health(): Promise<ProviderHealth> {
      const checkedAt = new Date().toISOString();
      if (!options.apiKey) {
        return { ok: false, detail: 'OPENAI_API_KEY is not set.', checkedAt };
      }
      // Deliberately not a live call: health is polled by the UI, and probing a
      // paid API on every page load would be rude.
      return { ok: true, detail: 'API key configured.', checkedAt };
    },

    transcription: createOpenAiTranscription(client, options.transcriptionModel),
    clipDiscovery: createOpenAiDiscovery(client, options.discoveryModel),
    // Refinement is the same kind of judgement over the same transcript text, so
    // it runs on the discovery model rather than introducing a third setting.
    clipRefinement: createOpenAiRefinement(client, options.discoveryModel),
  };
}

/** Registry entry point: reads the key and model names from validated config. */
export function openAiProviderFromConfig(config: AppConfig): AiProvider {
  const apiKey = config.ai.keys.openai;
  if (!apiKey) {
    throw aiError('provider_not_configured', 'OPENAI_API_KEY is required to use the OpenAI provider.', {
      details: { variable: 'OPENAI_API_KEY' },
    });
  }

  return createOpenAiProvider({
    apiKey,
    transcriptionModel: config.ai.models.openaiTranscription,
    discoveryModel: config.ai.models.openaiDiscovery,
  });
}
