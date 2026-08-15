/**
 * OpenAI adapter contract.
 *
 * Every request is served by a stub `fetch`, so this suite never touches the
 * network and never needs a key. It pins the contract: what we send, what we
 * accept back, and what we refuse.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOpenAiProvider } from '@/ai/providers/openai';
import { extractJsonContent } from '@/ai/providers/openai/discovery';
import { logprobToConfidence } from '@/ai/providers/openai/transcription';
import { requireClipDiscovery, requireTranscription } from '@/ai/registry';
import { CANDIDATE_MAX_DURATION_SEC, CANDIDATE_MIN_DURATION_SEC } from '@/domain';
import type { FetchLike } from '@/ai/providers/openai/client';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const provider = (fetchImpl: FetchLike) =>
  createOpenAiProvider({
    apiKey: 'test-key',
    transcriptionModel: 'whisper-1',
    discoveryModel: 'gpt-4o-mini',
    fetchImpl,
  });

/* -------------------------------------------------------------------------- */
/* Transcription                                                              */
/* -------------------------------------------------------------------------- */

const TRANSCRIPTION_BODY = {
  language: 'english',
  duration: 12.5,
  text: 'I thought it would take a year. It took three weeks.',
  segments: [
    { start: 0, end: 6.2, text: ' I thought it would take a year.', avg_logprob: -0.15 },
    { start: 6.2, end: 12.5, text: ' It took three weeks.', avg_logprob: -0.4 },
  ],
  words: [
    { word: 'I', start: 0, end: 0.3 },
    { word: 'thought', start: 0.3, end: 0.8 },
    { word: 'It', start: 6.3, end: 6.6 },
    { word: 'took', start: 6.6, end: 7.0 },
  ],
};

describe('OpenAI transcription adapter', () => {
  it('requests verbose_json with segment and word granularity', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(TRANSCRIPTION_BODY));

    await requireTranscription(provider(fetchImpl)).transcribe({
      audioPath: mockAudioPath(),
      durationSec: 12.5,
      languageHint: 'en',
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');

    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['segment', 'word']);
    expect(form.get('language')).toBe('en');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('sends the API key as a bearer token', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(TRANSCRIPTION_BODY));
    await requireTranscription(provider(fetchImpl)).transcribe({
      audioPath: mockAudioPath(),
      durationSec: 12.5,
    });

    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
  });

  it('maps segments verbatim and attaches words by time overlap', async () => {
    const draft = await requireTranscription(provider(async () => jsonResponse(TRANSCRIPTION_BODY))).transcribe({
      audioPath: mockAudioPath(),
      durationSec: 12.5,
    });

    expect(draft.model).toBe('whisper-1');
    expect(draft.language).toBe('english');
    expect(draft.segments).toHaveLength(2);

    // Text is passed through untouched — no trimming, no re-punctuation.
    expect(draft.segments[0]!.text).toBe(' I thought it would take a year.');
    expect(draft.segments[0]!.words?.map((w) => w.text)).toEqual(['I', 'thought']);
    expect(draft.segments[1]!.words?.map((w) => w.text)).toEqual(['It', 'took']);
  });

  it('converts avg_logprob into a 0..1 confidence', async () => {
    const draft = await requireTranscription(provider(async () => jsonResponse(TRANSCRIPTION_BODY))).transcribe({
      audioPath: mockAudioPath(),
      durationSec: 12.5,
    });

    expect(draft.segments[0]!.confidence).toBeCloseTo(Math.exp(-0.15), 5);
    expect(draft.segments[0]!.confidence!).toBeGreaterThan(draft.segments[1]!.confidence!);
  });

  it('omits words entirely when the API returns none', async () => {
    const body = { ...TRANSCRIPTION_BODY, words: undefined };
    const draft = await requireTranscription(provider(async () => jsonResponse(body))).transcribe({
      audioPath: mockAudioPath(),
      durationSec: 12.5,
    });

    expect(draft.segments[0]!.words).toBeUndefined();
  });

  it('returns no segments rather than inventing one for silent audio', async () => {
    const draft = await requireTranscription(
      provider(async () => jsonResponse({ language: 'english', segments: [] })),
    ).transcribe({ audioPath: mockAudioPath(), durationSec: 5 });

    expect(draft.segments).toEqual([]);
  });

  it('rejects a response that does not match the expected shape', async () => {
    const bad = { segments: [{ start: 'zero', end: 3, text: 'hi' }] };

    await expect(
      requireTranscription(provider(async () => jsonResponse(bad))).transcribe({
        audioPath: mockAudioPath(),
        durationSec: 5,
      }),
    ).rejects.toMatchObject({ kind: 'ai', code: 'provider_response_invalid' });
  });

  it('declares the compact audio format it needs', () => {
    const spec = requireTranscription(provider(async () => jsonResponse({}))).audioSpec;

    expect(spec).toMatchObject({ format: 'ogg', sampleRateHz: 16_000, channels: 1 });
    expect(spec!.maxBytes).toBe(25 * 1024 * 1024);
  });
});

describe('logprobToConfidence', () => {
  it.each([
    [0, 1],
    [-Infinity, 0],
    [Number.NaN, 0],
  ])('maps %s to %s', (input, expected) => {
    expect(logprobToConfidence(input)).toBe(expected);
  });

  it('is monotonic', () => {
    expect(logprobToConfidence(-0.1)).toBeGreaterThan(logprobToConfidence(-1));
  });
});

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

describe('OpenAI error handling', () => {
  it('surfaces an API error message without leaking it to the client body', async () => {
    const failing = async () =>
      jsonResponse({ error: { message: 'Rate limit reached for whisper-1' } }, 429);

    await expect(
      requireTranscription(provider(failing)).transcribe({ audioPath: mockAudioPath(), durationSec: 5 }),
    ).rejects.toMatchObject({ kind: 'ai', code: 'provider_request_failed' });
  });

  it('reports an unreachable provider as an ai error, not an unexpected one', async () => {
    const offline = async () => {
      throw new TypeError('fetch failed');
    };

    await expect(
      requireTranscription(provider(offline)).transcribe({ audioPath: mockAudioPath(), durationSec: 5 }),
    ).rejects.toMatchObject({ kind: 'ai', code: 'provider_unreachable' });
  });

  it('reports a non-JSON body as an ai error', async () => {
    const html = async () => new Response('<html>502</html>', { status: 200 });

    await expect(
      requireTranscription(provider(html)).transcribe({ audioPath: mockAudioPath(), durationSec: 5 }),
    ).rejects.toMatchObject({ kind: 'ai', code: 'provider_response_unparseable' });
  });
});

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

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

const completion = (payload: unknown) =>
  jsonResponse({ choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }] });

const discoveryRequest = {
  segments: [{ startSec: 15, endSec: 55, text: 'I thought it would take a year.' }],
  videoDurationSec: 90,
  maxCandidates: 3,
  targetDurationSec: { min: CANDIDATE_MIN_DURATION_SEC, max: CANDIDATE_MAX_DURATION_SEC },
};

describe('OpenAI discovery adapter', () => {
  it('requests strict structured output', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => completion({ moments: [MOMENT] }));
    await requireClipDiscovery(provider(fetchImpl)).discoverClips(discoveryRequest);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it('sends the timed transcript and tells the model not to paraphrase', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => completion({ moments: [] }));
    await requireClipDiscovery(provider(fetchImpl)).discoverClips(discoveryRequest);

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.messages[0].content).toContain('CHARACTER FOR CHARACTER');
    expect(body.messages[1].content).toContain('[15.00 - 55.00] I thought it would take a year.');
  });

  it('maps a moment into the domain shape', async () => {
    const [candidate] = await requireClipDiscovery(provider(async () => completion({ moments: [MOMENT] }))).discoverClips(
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

  it('honours maxCandidates even if the model returns more', async () => {
    const many = { moments: Array.from({ length: 9 }, () => MOMENT) };
    const candidates = await requireClipDiscovery(provider(async () => completion(many))).discoverClips(
      discoveryRequest,
    );

    expect(candidates).toHaveLength(3);
  });

  it('skips the API call entirely for an empty transcript', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => completion({ moments: [] }));
    const candidates = await requireClipDiscovery(provider(fetchImpl)).discoverClips({
      ...discoveryRequest,
      segments: [],
    });

    expect(candidates).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a response that violates the schema', async () => {
    const invalid = { moments: [{ ...MOMENT, confidence: 5 }] };

    await expect(
      requireClipDiscovery(provider(async () => completion(invalid))).discoverClips(discoveryRequest),
    ).rejects.toMatchObject({ kind: 'ai', code: 'provider_response_invalid' });
  });

  it('rejects a response missing a required signal', async () => {
    const partialSignals: Record<string, unknown> = { ...MOMENT.signals };
    delete partialSignals.strong_opinion;
    const invalid = { moments: [{ ...MOMENT, signals: partialSignals }] };

    await expect(
      requireClipDiscovery(provider(async () => completion(invalid))).discoverClips(discoveryRequest),
    ).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });
});

describe('extractJsonContent', () => {
  it('parses the first choice', () => {
    expect(extractJsonContent({ choices: [{ message: { content: '{"moments":[]}' } }] })).toEqual({
      moments: [],
    });
  });

  it.each([
    [{ choices: [] }, 'provider_response_invalid'],
    [{}, 'provider_response_invalid'],
    [{ choices: [{ message: { content: null } }] }, 'provider_response_empty'],
    [{ choices: [{ message: { content: '   ' } }] }, 'provider_response_empty'],
    [{ choices: [{ message: { content: 'not json' } }] }, 'provider_response_unparseable'],
    [
      { choices: [{ message: { content: '{"moments":' }, finish_reason: 'length' }] },
      'provider_response_truncated',
    ],
  ])('rejects %j as %s', (raw, code) => {
    expect(() => extractJsonContent(raw)).toThrowError(expect.objectContaining({ kind: 'ai', code }));
  });
});

describe('provider health', () => {
  it('does not call the API to report health', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({}));
    const health = await provider(fetchImpl).health();

    expect(health.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports unhealthy without a key', async () => {
    const bare = createOpenAiProvider({
      apiKey: '',
      transcriptionModel: 'whisper-1',
      discoveryModel: 'gpt-4o-mini',
      fetchImpl: async () => jsonResponse({}),
    });

    await expect(bare.health()).resolves.toMatchObject({ ok: false });
  });
});

/**
 * The adapter streams the audio off disk, so the path has to be real. A few
 * bytes in a temp file are enough to prove it is opened and attached.
 */
let audioDir: string;
let audioFile: string;

beforeAll(async () => {
  audioDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-openai-'));
  audioFile = path.join(audioDir, 'speech.ogg');
  await fsp.writeFile(audioFile, Buffer.from('fake opus bytes'));
});

afterAll(async () => {
  await fsp.rm(audioDir, { recursive: true, force: true });
});

const mockAudioPath = (): string => audioFile;
