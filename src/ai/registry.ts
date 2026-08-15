/**
 * Provider resolution.
 *
 * The registry is the only place that knows which concrete providers exist.
 * Adding Gemini means registering a factory here — no call site changes.
 */

import { aiError } from '@/lib/errors';
import type { AppConfig, AiProviderId } from '@/config/env';
import { createMockProvider } from './providers/mock';
import { openAiProviderFromConfig } from './providers/openai';
import { nvidiaProviderFromConfig } from './providers/nvidia';
import {
  supports,
  type AiProvider,
  type ClipDiscoveryCapability,
  type ClipRefinementCapability,
  type FramingCapability,
  type TranscriptionCapability,
} from './types';

/** A provider factory receives config so it can read its own API key. */
export type ProviderFactory = (config: AppConfig) => AiProvider;

const FACTORIES: Partial<Record<AiProviderId, ProviderFactory>> = {
  mock: () => createMockProvider(),
  openai: openAiProviderFromConfig,
  nvidia: nvidiaProviderFromConfig,
  // Later phases: gemini.
};

export const registeredProviderIds = (): readonly AiProviderId[] =>
  Object.keys(FACTORIES) as AiProviderId[];

/**
 * Build the provider named by `AI_PROVIDER`.
 * @throws AppError kind=ai when the provider has no implementation yet
 */
export function resolveProvider(config: AppConfig): AiProvider {
  const factory = FACTORIES[config.ai.provider];
  if (!factory) {
    throw aiError('provider_not_available', `AI provider "${config.ai.provider}" is not implemented yet.`, {
      details: { requested: config.ai.provider, available: registeredProviderIds() },
    });
  }
  return factory(config);
}

/* -------------------------------------------------------------------------- */
/* Capability guards — turn an optional field into a checked dependency.       */
/* -------------------------------------------------------------------------- */

export function requireTranscription(provider: AiProvider): TranscriptionCapability {
  if (!supports(provider, 'transcription') || !provider.transcription) {
    throw missing(provider.id, 'transcription');
  }
  return provider.transcription;
}

export function requireClipDiscovery(provider: AiProvider): ClipDiscoveryCapability {
  if (!supports(provider, 'clip-discovery') || !provider.clipDiscovery) {
    throw missing(provider.id, 'clip-discovery');
  }
  return provider.clipDiscovery;
}

/**
 * Clip refinement is an *enhancement*, not a dependency: scoring has a complete
 * deterministic path without it. So this returns null rather than throwing — a
 * provider that cannot read clips must not stop clips being built.
 */
export function optionalClipRefinement(provider: AiProvider): ClipRefinementCapability | null {
  if (!supports(provider, 'clip-refinement') || !provider.clipRefinement) return null;
  return provider.clipRefinement;
}

export function requireFraming(provider: AiProvider): FramingCapability {
  if (!supports(provider, 'framing') || !provider.framing) {
    throw missing(provider.id, 'framing');
  }
  return provider.framing;
}

const missing = (providerId: AiProviderId, capability: string) =>
  aiError('capability_unsupported', `Provider "${providerId}" does not support ${capability}.`, {
    details: { providerId, capability },
  });
