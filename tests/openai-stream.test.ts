/**
 * Streaming chat completions.
 *
 * NVIDIA discovery runs over `stream: true` because the gateway 504s a long
 * non-streaming generation at its own deadline. Nothing downstream may notice:
 * the SSE deltas must reassemble into exactly the completion shape the
 * non-streaming endpoint returns, and every failure mode of the stream must map
 * onto the same error codes the buffered path already raises.
 *
 * No network and no key: every response here is a hand-built `Response`.
 */

import { describe, expect, it, vi } from 'vitest';
import { OpenAiClient, type FetchLike } from '@/ai/providers/openai/client';
import { assembleSseCompletion, readSseData } from '@/ai/providers/openai/stream';
import { createNvidiaProvider } from '@/ai/providers/nvidia';
import { requireClipDiscovery } from '@/ai/registry';
import { CANDIDATE_MAX_DURATION_SEC, CANDIDATE_MIN_DURATION_SEC } from '@/domain';

const encoder = new TextEncoder();

/** A body that emits the given strings as-is, so chunk splitting is testable. */
const streamOf = (chunks: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

const sseResponse = (chunks: readonly string[]): Response =>
  new Response(streamOf(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** One `chat.completion.chunk` carrying a content delta. */
const delta = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;

const finish = (reason = 'stop'): string =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;

const collect = async (stream: ReadableStream<Uint8Array>): Promise<string[]> => {
  const out: string[] = [];
  for await (const data of readSseData(stream)) out.push(data);
  return out;
};

const client = (fetchImpl: FetchLike, timeoutMs = 10_000) =>
  new OpenAiClient({ apiKey: 'test-key', baseUrl: 'https://example.test/v1', fetchImpl, timeoutMs });

/* -------------------------------------------------------------------------- */
/* SSE framing                                                                */
/* -------------------------------------------------------------------------- */

describe('readSseData', () => {
  it('yields the data payload of each event in order', async () => {
    expect(await collect(streamOf(['data: one\n\ndata: two\n\n']))).toEqual(['one', 'two']);
  });

  it('reassembles events split across network chunks', async () => {
    expect(await collect(streamOf(['data: {"a"', ':1}\n', '\ndata: {"b":2}\n\n']))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('accepts CRLF line endings', async () => {
    expect(await collect(streamOf(['data: one\r\n\r\ndata: two\r\n\r\n']))).toEqual(['one', 'two']);
  });

  it('joins multiple data lines of one event with a newline', async () => {
    expect(await collect(streamOf(['data: first\ndata: second\n\n']))).toEqual(['first\nsecond']);
  });

  it('skips comments, unknown fields and events with no data line', async () => {
    const raw = ': keep-alive\n\nevent: ping\nid: 7\n\ndata: real\n\n';
    expect(await collect(streamOf([raw]))).toEqual(['real']);
  });

  it('emits a final event that was flushed without a trailing blank line', async () => {
    expect(await collect(streamOf(['data: one\n\ndata: [DONE]']))).toEqual(['one', '[DONE]']);
  });

  it('yields nothing for an empty body', async () => {
    expect(await collect(streamOf([]))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Reassembly into a completion                                               */
/* -------------------------------------------------------------------------- */

describe('assembleSseCompletion', () => {
  it('concatenates every content delta into one completion, in order', async () => {
    const body = streamOf([delta('{"mom'), delta('ents":'), delta('[]}'), finish(), 'data: [DONE]\n\n']);
    const completion = await assembleSseCompletion(body, '/chat/completions');

    expect(completion.choices[0].message.content).toBe('{"moments":[]}');
    expect(completion.choices[0].finish_reason).toBe('stop');
  });

  it('ignores chunks that carry no content — role openers, usage, empty choices', async () => {
    const body = streamOf([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [] })}\n\n`,
      `data: ${JSON.stringify({ usage: { total_tokens: 12 } })}\n\n`,
      delta('ok'),
      finish(),
    ]);

    expect((await assembleSseCompletion(body, '/p')).choices[0].message.content).toBe('ok');
  });

  it('stops reading at [DONE]', async () => {
    const body = streamOf([delta('kept'), 'data: [DONE]\n\n', delta('ignored')]);
    expect((await assembleSseCompletion(body, '/p')).choices[0].message.content).toBe('kept');
  });

  it('preserves finish_reason=length so truncation is still detectable downstream', async () => {
    const body = streamOf([delta('{"moments":'), finish('length'), 'data: [DONE]\n\n']);
    expect((await assembleSseCompletion(body, '/p')).choices[0].finish_reason).toBe('length');
  });

  it('rejects a stream that ends before [DONE] or a finish_reason', async () => {
    await expect(assembleSseCompletion(streamOf([delta('half')]), '/p')).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_response_truncated',
    });
  });

  it('rejects a malformed SSE chunk instead of silently dropping content', async () => {
    const body = streamOf([delta('ok'), 'data: {not json\n\n', finish()]);
    await expect(assembleSseCompletion(body, '/p')).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_response_unparseable',
    });
  });

  it('treats a missing body as a truncated stream', async () => {
    await expect(assembleSseCompletion(null, '/p')).rejects.toMatchObject({ code: 'provider_response_truncated' });
  });
});

/* -------------------------------------------------------------------------- */
/* Client behaviour                                                           */
/* -------------------------------------------------------------------------- */

describe('OpenAiClient.postJsonStream', () => {
  it('asks for a stream and keeps the caller-supplied body intact', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => sseResponse([delta('{}'), finish(), 'data: [DONE]\n\n']));
    await client(fetchImpl).postJsonStream('/chat/completions', { model: 'm', temperature: 0.2 });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'm', temperature: 0.2, stream: true });
    expect((init.headers as Record<string, string>).accept).toBe('text/event-stream');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
  });

  it('returns the assembled completion in non-streaming shape', async () => {
    const fetchImpl: FetchLike = async () => sseResponse([delta('hello '), delta('world'), finish(), 'data: [DONE]\n\n']);
    const raw = await client(fetchImpl).postJsonStream<{
      choices: { message: { content: string }; finish_reason: string }[];
    }>('/chat/completions', { model: 'm' });

    expect(raw.choices[0]!.message.content).toBe('hello world');
  });

  it('falls back to the JSON body when the server ignores stream', async () => {
    const buffered = { choices: [{ message: { content: '{"moments":[]}' }, finish_reason: 'stop' }] };
    const raw = await client(async () => jsonResponse(buffered)).postJsonStream('/chat/completions', { model: 'm' });

    expect(raw).toEqual(buffered);
  });

  it('surfaces a non-2xx response before reading any stream', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: { message: 'gateway timeout' } }, 504);

    await expect(client(fetchImpl).postJsonStream('/chat/completions', { model: 'm' })).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_request_failed',
      details: { status: 504 },
    });
  });

  it('reports a transport failure as provider_unreachable', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };

    await expect(client(fetchImpl).postJsonStream('/chat/completions', { model: 'm' })).rejects.toMatchObject({
      code: 'provider_unreachable',
    });
  });

  it('reports a connection lost mid-stream as provider_unreachable', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(delta('partial')));
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );

    await expect(client(fetchImpl).postJsonStream('/chat/completions', { model: 'm' })).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_unreachable',
    });
  });

  it('reports an abort while the stream is open as provider_timeout', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(delta('partial')));
            const aborted = new Error('The operation was aborted.');
            aborted.name = 'AbortError';
            controller.error(aborted);
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );

    await expect(client(fetchImpl).postJsonStream('/chat/completions', { model: 'm' })).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_timeout',
    });
  });

  it('aborts a request that never answers, using the configured timeout', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const aborted = new Error('The operation was aborted.');
          aborted.name = 'AbortError';
          reject(aborted);
        });
      });

    await expect(client(fetchImpl, 10).postJsonStream('/chat/completions', { model: 'm' })).rejects.toMatchObject({
      code: 'provider_timeout',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* NVIDIA discovery over the stream                                           */
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

const discoveryRequest = {
  segments: [{ startSec: 15, endSec: 55, text: 'I thought it would take a year.' }],
  videoDurationSec: 90,
  maxCandidates: 3,
  targetDurationSec: { min: CANDIDATE_MIN_DURATION_SEC, max: CANDIDATE_MAX_DURATION_SEC },
};

const nvidiaDiscovery = (fetchImpl: FetchLike) =>
  requireClipDiscovery(
    createNvidiaProvider({
      apiKey: 'test-key',
      discoveryModel: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      transcriptionModel: 'nvidia/parakeet-tdt-0.6b-v2',
      fetchImpl,
      rivaTransport: async function* () {},
    }),
  );

describe('NVIDIA discovery over SSE', () => {
  it('requests a stream', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      sseResponse([delta('{"moments":[]}'), finish(), 'data: [DONE]\n\n']),
    );
    await nvidiaDiscovery(fetchImpl).discoverClips(discoveryRequest);

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toBeUndefined();
  });

  it('parses candidates from JSON split arbitrarily across deltas', async () => {
    const json = JSON.stringify({ moments: [MOMENT] });
    const chunks = json.match(/.{1,7}/gs)!.map(delta);
    const fetchImpl: FetchLike = async () => sseResponse([...chunks, finish(), 'data: [DONE]\n\n']);

    const [candidate] = await nvidiaDiscovery(fetchImpl).discoverClips(discoveryRequest);

    expect(candidate).toMatchObject({
      startSec: 15,
      endSec: 55,
      hookQuote: 'I thought it would take a year',
      topic: 'Shipping fast',
      confidence: 0.82,
    });
    expect(candidate!.signals).toMatchObject({ strongOpening: true, surprise: true, standalone: 0.9 });
  });

  it('still rejects a streamed body that does not match the schema', async () => {
    const json = JSON.stringify({ moments: [{ ...MOMENT, confidence: 5 }] });
    const fetchImpl: FetchLike = async () => sseResponse([delta(json), finish(), 'data: [DONE]\n\n']);

    await expect(nvidiaDiscovery(fetchImpl).discoverClips(discoveryRequest)).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_response_invalid',
    });
  });

  it('reports an empty stream as an empty response, not as candidates', async () => {
    const fetchImpl: FetchLike = async () => sseResponse([finish(), 'data: [DONE]\n\n']);

    await expect(nvidiaDiscovery(fetchImpl).discoverClips(discoveryRequest)).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_response_empty',
    });
  });

  it('reports a stream cut short by the gateway as truncated', async () => {
    const fetchImpl: FetchLike = async () => sseResponse([delta('{"moments":[')]);

    await expect(nvidiaDiscovery(fetchImpl).discoverClips(discoveryRequest)).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_response_truncated',
    });
  });
});
