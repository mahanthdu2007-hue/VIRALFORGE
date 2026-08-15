/**
 * NVIDIA adapter contract.
 *
 * Every request is served by a stub `fetch`, so this suite never touches the
 * network and never needs a real key. It pins the contract: correct base URL,
 * correct model name, bearer auth, and — since NVIDIA does not expose
 * structured output for this model — safe parsing of plain-text JSON with the
 * same strict Zod validation the OpenAI adapter uses.
 */

import { describe, expect, it, vi } from 'vitest';
import { createNvidiaProvider, NVIDIA_BASE_URL } from '@/ai/providers/nvidia';
import { requireClipDiscovery as requireDiscovery, optionalClipRefinement } from '@/ai/registry';
import { CANDIDATE_MAX_DURATION_SEC, CANDIDATE_MIN_DURATION_SEC } from '@/domain';
import type { FetchLike } from '@/ai/providers/openai/client';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const NVIDIA_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const NVIDIA_ASR_MODEL = 'nvidia/parakeet-tdt-0.6b-v2';

const provider = (fetchImpl: FetchLike) =>
  createNvidiaProvider({
    apiKey: 'test-key',
    discoveryModel: NVIDIA_MODEL,
    transcriptionModel: NVIDIA_ASR_MODEL,
    fetchImpl,
    // Never reached by these tests; present so constructing the provider can
    // never open a gRPC channel.
    rivaTransport: async function* () {},
  });

const completion = (payload: unknown) =>
  jsonResponse({ choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }] });

const discoveryRequest = {
  segments: [{ startSec: 15, endSec: 55, text: 'I thought it would take a year.' }],
  videoDurationSec: 90,
  maxCandidates: 3,
  targetDurationSec: { min: CANDIDATE_MIN_DURATION_SEC, max: CANDIDATE_MAX_DURATION_SEC },
};

const MOMENT = {
  start_sec: 15,
  end_sec: 55,
  hook_quote: 'I thought it would take a year',
  topic: 'Shipping fast',
  reason: 'Sets an expectation and breaks it.',
  confidence: 0.82,
  signals: {
    strong_opening: true,
    question_answered: false,
    strong_opinion: true,
    surprise: true,
    story: false,
    payoff: true,
    emotional_intensity: 0.6,
    information_density: 0.7,
    standalone: 0.9,
  },
};

const REFINEMENT = {
  title: 'Shipping ahead of schedule',
  hook_quote: 'I thought it would take a year',
  curiosity: 0.7,
  standalone: 0.8,
  payoff: 0.6,
  context_dependency: 0.2,
  notes: 'Clear before/after contrast.',
};

const refinementRequest = {
  clipText: 'I thought it would take a year. It took three weeks.',
  startSec: 15,
  endSec: 55,
  topic: 'Shipping fast',
};

/* -------------------------------------------------------------------------- */
/* Configuration: base URL, model, auth                                       */
/* -------------------------------------------------------------------------- */

describe('NVIDIA provider configuration', () => {
  it('exposes the documented integrate.api.nvidia.com base URL', () => {
    expect(NVIDIA_BASE_URL).toBe('https://integrate.api.nvidia.com/v1');
  });

  it('sends discovery requests to the NVIDIA base URL', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => completion({ moments: [MOMENT] }));
    await requireDiscovery(provider(fetchImpl)).discoverClips(discoveryRequest);

    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
  });

  it('sends the configured NVIDIA model name', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => completion({ moments: [] }));
    await requireDiscovery(provider(fetchImpl)).discoverClips(discoveryRequest);

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.model).toBe(NVIDIA_MODEL);
  });

  it('authenticates with a bearer token built from NVIDIA_API_KEY', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => completion({ moments: [] }));
    await requireDiscovery(provider(fetchImpl)).discoverClips(discoveryRequest);

    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
  });

  it('never sends response_format, since structured output is not supported', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => completion({ moments: [] }));
    await requireDiscovery(provider(fetchImpl)).discoverClips(discoveryRequest);

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.response_format).toBeUndefined();
  });

  it('reports unhealthy without an API key', async () => {
    const bare = createNvidiaProvider({
      apiKey: '',
      discoveryModel: NVIDIA_MODEL,
      transcriptionModel: NVIDIA_ASR_MODEL,
      fetchImpl: async () => jsonResponse({}),
      rivaTransport: async function* () {},
    });

    await expect(bare.health()).resolves.toMatchObject({ ok: false, detail: expect.stringContaining('NVIDIA_API_KEY') });
  });

  it('declares all three capabilities, so AI_PROVIDER=nvidia needs no second provider', () => {
    const p = provider(async () => jsonResponse({}));
    expect(p.capabilities).toEqual(['transcription', 'clip-discovery', 'clip-refinement']);
    expect(p.transcription).toBeDefined();
    expect(p.clipDiscovery).toBeDefined();
    expect(p.clipRefinement).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Discovery: valid parsing, malformed rejection, schema validation           */
/* -------------------------------------------------------------------------- */

describe('NVIDIA discovery adapter', () => {
  it('parses a valid plain-text JSON response into the domain shape', async () => {
    const [candidate] = await requireDiscovery(provider(async () => completion({ moments: [MOMENT] }))).discoverClips(
      discoveryRequest,
    );

    expect(candidate).toMatchObject({
      startSec: 15,
      endSec: 55,
      hookQuote: 'I thought it would take a year',
      topic: 'Shipping fast',
      confidence: 0.82,
    });
    expect(candidate!.signals).toMatchObject({ strongOpening: true, surprise: true, standalone: 0.9 });
  });

  it('tells the model the exact JSON shape and not to paraphrase quotes', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => completion({ moments: [] }));
    await requireDiscovery(provider(fetchImpl)).discoverClips(discoveryRequest);

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.messages[0].content).toContain('CHARACTER FOR CHARACTER');
    expect(body.messages[0].content).toContain('"moments"');
  });

  it('rejects a response body that is not JSON at all', async () => {
    const notJson = jsonResponse({
      choices: [{ message: { content: 'Sure! Here are the moments: not actually JSON' }, finish_reason: 'stop' }],
    });

    await expect(
      requireDiscovery(provider(async () => notJson)).discoverClips(discoveryRequest),
    ).rejects.toMatchObject({ kind: 'ai', code: 'provider_response_unparseable' });
  });

  it('rejects JSON that violates the schema rather than repairing it', async () => {
    const invalid = { moments: [{ ...MOMENT, confidence: 5 }] };

    await expect(
      requireDiscovery(provider(async () => completion(invalid))).discoverClips(discoveryRequest),
    ).rejects.toMatchObject({ kind: 'ai', code: 'provider_response_invalid' });
  });

  it('reports a network failure as an ai error, not an unexpected one', async () => {
    const offline: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };

    await expect(requireDiscovery(provider(offline)).discoverClips(discoveryRequest)).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_unreachable',
    });
  });

  it('surfaces a provider error response without a silent fallback', async () => {
    const failing: FetchLike = async () => jsonResponse({ error: { message: 'model overloaded' } }, 503);

    await expect(requireDiscovery(provider(failing)).discoverClips(discoveryRequest)).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_request_failed',
    });
  });

  it('skips the API call entirely for an empty transcript', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => completion({ moments: [] }));
    const candidates = await requireDiscovery(provider(fetchImpl)).discoverClips({
      ...discoveryRequest,
      segments: [],
    });

    expect(candidates).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Refinement                                                                 */
/* -------------------------------------------------------------------------- */

describe('NVIDIA refinement adapter', () => {
  it('parses a valid plain-text JSON response into the domain shape', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => completion(REFINEMENT));
    const refinement = optionalClipRefinement(provider(fetchImpl));
    expect(refinement).not.toBeNull();

    const draft = await refinement!.refineClip(refinementRequest);
    expect(draft).toMatchObject({
      title: 'Shipping ahead of schedule',
      hookQuote: 'I thought it would take a year',
      curiosity: 0.7,
    });
  });

  it('does not send response_format', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => completion(REFINEMENT));
    const refinement = optionalClipRefinement(provider(fetchImpl))!;
    await refinement.refineClip(refinementRequest);

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.response_format).toBeUndefined();
    expect(body.model).toBe(NVIDIA_MODEL);
  });

  it('rejects a refinement response that violates the schema', async () => {
    const invalid = { ...REFINEMENT, curiosity: 2 };
    const refinement = optionalClipRefinement(provider(async () => completion(invalid)))!;

    await expect(refinement.refineClip(refinementRequest)).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_response_invalid',
    });
  });

  it('rejects a malformed (non-JSON) refinement response', async () => {
    const bad = jsonResponse({
      choices: [{ message: { content: '```json\n{"title": "oops"' }, finish_reason: 'stop' }],
    });
    const refinement = optionalClipRefinement(provider(async () => bad))!;

    await expect(refinement.refineClip(refinementRequest)).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_response_unparseable',
    });
  });
});
