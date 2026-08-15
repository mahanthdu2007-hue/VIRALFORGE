/**
 * NVIDIA provider — the complete one.
 *
 * Supplies all three AI capabilities the pipeline needs, so `AI_PROVIDER=nvidia`
 * with a single `NVIDIA_API_KEY` is a working production configuration and
 * `OPENAI_API_KEY` is not required for anything.
 *
 * Two transports, because NVIDIA exposes the two model families differently:
 *
 *   discovery + refinement  HTTPS chat-completions at integrate.api.nvidia.com,
 *                           OpenAI-compatible, shared client with the OpenAI
 *                           adapter.
 *   transcription           Riva `StreamingRecognize` over gRPC at
 *                           grpc.nvcf.nvidia.com. The integrate host has no
 *                           `/v1/audio/transcriptions` route and lists no ASR
 *                           model, so there is no HTTP path to Parakeet.
 *
 * The NVIDIA model page for `nvidia/nemotron-3.5-lightning-30b-a3b` does not
 * list structured-output (`response_format`/`json_schema`) as a supported
 * capability, so unlike the OpenAI adapter the chat path never sends
 * `response_format`: the prompt spells out the required JSON shape in text, and
 * the response is parsed and Zod-validated exactly like any other untrusted
 * model output. A malformed reply fails cleanly — nothing is repaired or
 * invented.
 */

import { aiError } from '@/lib/errors';
import type { AppConfig } from '@/config/env';
import type { AiProvider, ProviderHealth } from '@/ai/types';
import { OpenAiClient, type FetchLike } from '../openai/client';
import { createNvidiaDiscovery } from './discovery';
import { createNvidiaRefinement } from './refinement';
import { createNvidiaTranscription } from './transcription';
import { createGrpcRivaUnaryTransport, NVIDIA_ASR_ENDPOINT, type RivaAsrTransport } from './riva/transport';

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export { NVIDIA_ASR_ENDPOINT };
export { NVIDIA_AUDIO_SPEC, NVIDIA_ASR_FUNCTION_IDS } from './transcription';
export type { RivaAsrTransport } from './riva/transport';

export interface NvidiaProviderOptions {
  readonly apiKey: string;
  readonly transcriptionModel: string;
  readonly discoveryModel: string;
  readonly baseUrl?: string;
  /** `host:port` of the Riva gateway. Defaults to NVIDIA's hosted NVCF one. */
  readonly asrEndpoint?: string;
  /** NVCF function id, when the model is not in the built-in lookup. */
  readonly asrFunctionId?: string;
  /** Injected by tests to exercise the chat adapters without network access. */
  readonly fetchImpl?: FetchLike;
  /** Injected by tests to exercise the ASR adapter without gRPC. */
  readonly rivaTransport?: RivaAsrTransport;
}

export function createNvidiaProvider(options: NvidiaProviderOptions): AiProvider {
  const client = new OpenAiClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? NVIDIA_BASE_URL,
    providerLabel: 'NVIDIA',
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  return {
    id: 'nvidia',
    displayName: `NVIDIA (${options.transcriptionModel} / ${options.discoveryModel})`,
    capabilities: ['transcription', 'clip-discovery', 'clip-refinement'],

    async health(): Promise<ProviderHealth> {
      const checkedAt = new Date().toISOString();
      if (!options.apiKey) {
        return { ok: false, detail: 'NVIDIA_API_KEY is not set.', checkedAt };
      }
      // Deliberately not a live call: health is polled by the UI, and probing a
      // paid API on every page load would be rude.
      return { ok: true, detail: 'API key configured.', checkedAt };
    },

    transcription: createNvidiaTranscription({
      apiKey: options.apiKey,
      model: options.transcriptionModel,
      endpoint: options.asrEndpoint ?? NVIDIA_ASR_ENDPOINT,
      ...(options.asrFunctionId ? { functionId: options.asrFunctionId } : {}),
      // The gRPC channel is opened on first use, so a run that never
      // transcribes never loads it. Unary `Recognize`, not `StreamingRecognize`:
      // see `riva/transport.ts` for why the NVCF-hosted function needs it.
      transport: options.rivaTransport ?? createGrpcRivaUnaryTransport(),
    }),
    clipDiscovery: createNvidiaDiscovery(client, options.discoveryModel),
    // Refinement is the same kind of judgement over the same transcript text, so
    // it runs on the discovery model rather than introducing a third setting.
    clipRefinement: createNvidiaRefinement(client, options.discoveryModel),
  };
}

/** Registry entry point: reads the key and model names from validated config. */
export function nvidiaProviderFromConfig(config: AppConfig): AiProvider {
  const apiKey = config.ai.keys.nvidia;
  if (!apiKey) {
    throw aiError('provider_not_configured', 'NVIDIA_API_KEY is required to use the NVIDIA provider.', {
      details: { variable: 'NVIDIA_API_KEY' },
    });
  }

  return createNvidiaProvider({
    apiKey,
    transcriptionModel: config.ai.models.nvidiaTranscription,
    discoveryModel: config.ai.models.nvidiaDiscovery,
    asrEndpoint: config.ai.nvidiaAsr.endpoint,
    ...(config.ai.nvidiaAsr.functionId ? { asrFunctionId: config.ai.nvidiaAsr.functionId } : {}),
  });
}
