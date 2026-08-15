/**
 * Unary `Recognize` transport contract.
 *
 * `@grpc/grpc-js` and `@grpc/proto-loader` are mocked so this suite never
 * opens a socket. It pins the two things that matter about switching off
 * `StreamingRecognize`: the audio chunks handed to the adapter are
 * concatenated back into one buffer and sent as a single `Recognize` call
 * (not re-chunked, not dropped), and a batch result — which carries no
 * `is_final` flag on the wire — is reported as final rather than silently
 * omitted by the streaming adapter that expects one.
 *
 * It also pins the error-mapping fix: NVCF's gateway returns
 * `INVALID_ARGUMENT` with an empty `details` string for a request shape it
 * rejects (confirmed against the live endpoint), and the previous mapping
 * produced a message that trailed off after a colon with nothing after it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RivaCallOptions, RivaStreamingRequest } from '@/ai/providers/nvidia/riva/transport';

const recognizeMock = vi.fn();
const setMock = vi.fn();

vi.mock('@grpc/proto-loader', () => ({
  fromJSON: vi.fn(() => ({})),
}));

vi.mock('@grpc/grpc-js', () => {
  class FakeMetadata {
    set(key: string, value: string) {
      setMock(key, value);
    }
  }
  return {
    loadPackageDefinition: vi.fn(() => ({
      nvidia: { riva: { asr: { RivaSpeechRecognition: vi.fn().mockImplementation(() => ({ Recognize: recognizeMock })) } } },
    })),
    credentials: { createSsl: vi.fn(() => ({})) },
    Metadata: FakeMetadata,
  };
});

async function* requestsOf(...requests: RivaStreamingRequest[]) {
  for (const r of requests) yield r;
}

const OPTIONS: RivaCallOptions = {
  endpoint: 'grpc.nvcf.nvidia.com:443',
  metadata: { authorization: 'Bearer test-key', 'function-id': 'fn-id' },
  timeoutMs: 5_000,
};

const CONFIG = {
  encoding: 'LINEAR_PCM' as const,
  sample_rate_hertz: 16_000,
  language_code: 'en-US',
  max_alternatives: 1,
  audio_channel_count: 1,
  enable_word_time_offsets: true,
  enable_automatic_punctuation: true,
  model: '',
  verbatim_transcripts: true,
};

beforeEach(() => {
  recognizeMock.mockReset();
  setMock.mockReset();
});

describe('createGrpcRivaUnaryTransport', () => {
  it('concatenates chunked audio_content into one buffer and sends a single Recognize call', async () => {
    recognizeMock.mockImplementation((_request, _metadata, _options, callback) => callback(null, { results: [] }));

    const { createGrpcRivaUnaryTransport } = await import('@/ai/providers/nvidia/riva/transport');
    const transport = createGrpcRivaUnaryTransport();

    const chunkA = new Uint8Array([1, 2, 3]);
    const chunkB = new Uint8Array([4, 5]);
    const results = [];
    for await (const r of transport(
      OPTIONS,
      requestsOf(
        { streaming_config: { config: CONFIG, interim_results: false } },
        { audio_content: chunkA },
        { audio_content: chunkB },
      ),
    )) {
      results.push(r);
    }

    expect(recognizeMock).toHaveBeenCalledTimes(1);
    const [request] = recognizeMock.mock.calls[0]!;
    expect(request.config).toEqual(CONFIG);
    expect(Array.from(request.audio as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
  });

  it('sends bearer auth and function-id as call metadata', async () => {
    recognizeMock.mockImplementation((_request, _metadata, _options, callback) => callback(null, { results: [] }));

    const { createGrpcRivaUnaryTransport } = await import('@/ai/providers/nvidia/riva/transport');
    const transport = createGrpcRivaUnaryTransport();

    for await (const response of transport(
      OPTIONS,
      requestsOf({ streaming_config: { config: CONFIG, interim_results: false } }),
    )) {
      void response; // drain
    }

    expect(setMock).toHaveBeenCalledWith('authorization', 'Bearer test-key');
    expect(setMock).toHaveBeenCalledWith('function-id', 'fn-id');
  });

  it('marks every batch result final, since Recognize carries no is_final flag', async () => {
    recognizeMock.mockImplementation((_request, _metadata, _options, callback) =>
      callback(null, { results: [{ alternatives: [{ transcript: 'hello world' }] }] }),
    );

    const { createGrpcRivaUnaryTransport } = await import('@/ai/providers/nvidia/riva/transport');
    const transport = createGrpcRivaUnaryTransport();

    const results = [];
    for await (const r of transport(
      OPTIONS,
      requestsOf({ streaming_config: { config: CONFIG, interim_results: false } }),
    )) {
      results.push(r);
    }

    expect(results).toEqual([
      { results: [{ is_final: true, alternatives: [{ transcript: 'hello world' }] }] },
    ]);
  });

  it('surfaces a Recognize failure as an ai error, not a raw gRPC rejection', async () => {
    recognizeMock.mockImplementation((_request, _metadata, _options, callback) =>
      callback({ code: 3, details: '', metadata: { getMap: () => ({}) } }, undefined),
    );

    const { createGrpcRivaUnaryTransport } = await import('@/ai/providers/nvidia/riva/transport');
    const transport = createGrpcRivaUnaryTransport();

    await expect(async () => {
      for await (const response of transport(
        OPTIONS,
        requestsOf({ streaming_config: { config: CONFIG, interim_results: false } }),
      )) {
        void response; // drain
      }
    }).rejects.toMatchObject({ kind: 'ai', code: 'provider_request_failed' });
  });
});

describe('toAiError (gRPC status mapping)', () => {
  it('names the status in the message when NVCF sends INVALID_ARGUMENT with no details text', async () => {
    const { toAiError } = await import('@/ai/providers/nvidia/riva/transport');

    const error = toAiError({ code: 3, details: '', metadata: { getMap: () => ({}) } }) as {
      message: string;
      details: Record<string, unknown>;
    };

    // The bug this guards: the message must never trail off into nothing
    // after the colon just because NVCF sent an empty details string.
    expect(error.message).toContain('INVALID_ARGUMENT');
    expect(error.message.trim().endsWith(':')).toBe(false);
    expect(error.details).toMatchObject({ status: 3, statusName: 'INVALID_ARGUMENT' });
  });

  it('carries the NVCF request id into logDetails for support correlation, never into client-facing details', async () => {
    const { toAiError } = await import('@/ai/providers/nvidia/riva/transport');

    const error = toAiError({
      code: 3,
      details: '',
      metadata: { getMap: () => ({ 'nvcf-reqid': 'e2f7b54f-1cab-42f0-b996-2b90337deb55' }) },
    }) as { logDetails: Record<string, unknown>; details: Record<string, unknown> };

    expect(error.logDetails).toMatchObject({ nvcfRequestId: 'e2f7b54f-1cab-42f0-b996-2b90337deb55' });
    expect(JSON.stringify(error.details)).not.toContain('e2f7b54f');
  });

  it('still maps DEADLINE_EXCEEDED and UNAVAILABLE to their own codes', async () => {
    const { toAiError } = await import('@/ai/providers/nvidia/riva/transport');

    expect(toAiError({ code: 4, details: 'deadline' })).toMatchObject({ code: 'provider_timeout' });
    expect(toAiError({ code: 14, details: 'unavailable' })).toMatchObject({ code: 'provider_unreachable' });
    expect(toAiError({ code: 16, details: '' })).toMatchObject({ code: 'provider_request_failed' });
  });
});
