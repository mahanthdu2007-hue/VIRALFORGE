/**
 * Riva `StreamingRecognize` transport.
 *
 * The seam that keeps gRPC out of everything else. The adapter above only sees
 * `RivaAsrTransport`: async iterable of requests in, async iterable of
 * responses out. Tests substitute a plain generator, so the whole transcription
 * suite runs with no network, no key and no gRPC channel.
 *
 * Why gRPC at all: NVIDIA's hosted `parakeet-tdt-0.6b-v2` is a Riva NVCF
 * function reached at `grpc.nvcf.nvidia.com:443`. `integrate.api.nvidia.com`
 * serves chat/embeddings only — it has no `/v1/audio/transcriptions` route and
 * its model list contains no ASR model — so the HTTP path used for discovery
 * cannot reach ASR. `@grpc/grpc-js` is pure JavaScript: no Python, no second
 * server, no native build step.
 *
 * The client is imported dynamically so that neither the Next.js bundle nor a
 * test run that never transcribes pays for loading it.
 */

import { aiError } from '@/lib/errors';
import { RIVA_ASR_DESCRIPTOR } from './descriptor';

/** NVIDIA's hosted Riva gateway. Overridable for a self-hosted Speech NIM. */
export const NVIDIA_ASR_ENDPOINT = 'grpc.nvcf.nvidia.com:443';

/* -------------------------------------------------------------------------- */
/* Wire shapes — snake_case because the descriptor is loaded with keepCase.    */
/* -------------------------------------------------------------------------- */

export interface RivaRecognitionConfig {
  readonly encoding: 'LINEAR_PCM';
  readonly sample_rate_hertz: number;
  readonly language_code: string;
  readonly max_alternatives: number;
  readonly audio_channel_count: number;
  readonly enable_word_time_offsets: boolean;
  readonly enable_automatic_punctuation: boolean;
  /** Riva model name. Empty when the NVCF function already selects the model. */
  readonly model: string;
  readonly verbatim_transcripts: boolean;
}

/** Exactly one field is set: the first message configures, the rest carry audio. */
export interface RivaStreamingRequest {
  readonly streaming_config?: {
    readonly config: RivaRecognitionConfig;
    readonly interim_results: boolean;
  };
  readonly audio_content?: Uint8Array;
}

export interface RivaWordInfo {
  /** Milliseconds from the start of the stream. */
  readonly start_time?: number;
  readonly end_time?: number;
  readonly word?: string;
  readonly confidence?: number;
}

export interface RivaAlternative {
  readonly transcript?: string;
  readonly confidence?: number;
  readonly words?: readonly RivaWordInfo[];
  readonly language_code?: readonly string[];
}

export interface RivaStreamingResult {
  readonly alternatives?: readonly RivaAlternative[];
  readonly is_final?: boolean;
}

export interface RivaStreamingResponse {
  readonly results?: readonly RivaStreamingResult[];
}

export interface RivaCallOptions {
  /** `host:port`. */
  readonly endpoint: string;
  /** Call metadata — bearer token and NVCF function id. */
  readonly metadata: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export type RivaAsrTransport = (
  options: RivaCallOptions,
  requests: AsyncIterable<RivaStreamingRequest>,
) => AsyncIterable<RivaStreamingResponse>;

/** Wire shape of the unary `Recognize` RPC's response. */
interface RivaRecognizeResponse {
  readonly results?: readonly {
    readonly alternatives?: readonly RivaAlternative[];
    readonly channel_tag?: number;
    readonly audio_processed?: number;
  }[];
}

/* -------------------------------------------------------------------------- */
/* gRPC implementation                                                        */
/* -------------------------------------------------------------------------- */

/** Minimal shape of the duplex stream we drive, so no gRPC type leaks outward. */
interface DuplexLike {
  write(value: RivaStreamingRequest): boolean;
  end(): void;
  destroy(): void;
  on(event: 'data', listener: (value: RivaStreamingResponse) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  once(event: 'drain', listener: () => void): unknown;
}

/**
 * The real transport. Returned lazily so importing this module does not pull in
 * gRPC; the channel is created on first use and reused for the process.
 */
export function createGrpcRivaTransport(): RivaAsrTransport {
  return async function* grpcTransport(options, requests) {
    const call = await openCall(options);
    yield* pump(call, requests);
  };
}

/**
 * Unary `Recognize` transport — what NVIDIA's NVCF-hosted `parakeet-tdt-0.6b-v2`
 * function actually serves. Confirmed against the live endpoint: the same
 * request content that `StreamingRecognize` rejects with an immediate,
 * message-less `INVALID_ARGUMENT` succeeds over `Recognize` unchanged.
 *
 * The adapter above (`transcription.ts`) still produces its request as a
 * config message followed by chunked `audio_content` messages, because that
 * shape is shared with the (still-declared, for a self-hosted Speech NIM)
 * streaming transport. This transport drains that stream, concatenates the
 * chunks back into one buffer, and sends a single `Recognize` call — so
 * nothing above this module needs to know which RPC is actually in play.
 */
export function createGrpcRivaUnaryTransport(): RivaAsrTransport {
  return async function* unaryTransport(options, requests) {
    let config: RivaRecognitionConfig | undefined;
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    for await (const request of requests) {
      if (request.streaming_config) config = request.streaming_config.config;
      if (request.audio_content) {
        chunks.push(request.audio_content);
        totalBytes += request.audio_content.byteLength;
      }
    }

    if (!config) {
      throw aiError('provider_request_failed', 'NVIDIA transcription built no configuration for the Recognize call.');
    }

    const audio = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      audio.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const { client, grpc } = await getClient(options.endpoint);
    const metadata = buildMetadata(grpc, options.metadata);

    const response = await new Promise<RivaRecognizeResponse>((resolve, reject) => {
      client.Recognize(
        { config, audio },
        metadata,
        { deadline: Date.now() + options.timeoutMs },
        (error, result) => (error ? reject(error) : resolve(result)),
      );
    }).catch((error: unknown) => {
      throw toAiError(error);
    });

    // Batch results carry no `is_final` flag — every result Recognize returns
    // is already final, so the mapping the streaming adapter expects is
    // synthesised rather than trusted from the wire.
    yield {
      results: (response.results ?? []).map((result) => ({
        is_final: true,
        alternatives: result.alternatives,
      })),
    };
  };
}

/** Cached per endpoint: one TCP/TLS channel serves every job. */
const clients = new Map<string, Promise<RivaServiceClient>>();

interface RivaServiceClient {
  StreamingRecognize(metadata: unknown, options: unknown): DuplexLike;
  Recognize(
    request: unknown,
    metadata: unknown,
    options: unknown,
    callback: (error: unknown, response: RivaRecognizeResponse) => void,
  ): unknown;
}

/**
 * Channel options raised above grpc-js's 4 MB default, in both directions.
 * `Recognize` carries a whole chunk as one `bytes` field. `transcription.ts`
 * caps each chunk at `NVIDIA_CHUNK_DURATION_SEC` (~9.6 MB at this pipeline's
 * 16 kHz mono audio spec) specifically so a source of any length never sends
 * one message anywhere near this ceiling — 64 MB is headroom for that cap to
 * change, not a limit callers are expected to approach.
 */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

async function getClient(endpoint: string): Promise<{ client: RivaServiceClient; grpc: typeof import('@grpc/grpc-js') }> {
  const [grpc, protoLoader] = await Promise.all([import('@grpc/grpc-js'), import('@grpc/proto-loader')]);

  let clientPromise = clients.get(endpoint);
  if (!clientPromise) {
    clientPromise = (async () => {
      const definition = protoLoader.fromJSON(RIVA_ASR_DESCRIPTOR as never, {
        // The descriptor is snake_case and so are the wire shapes above; letting
        // proto-loader camelCase them would silently rename every field.
        keepCase: true,
        // `start_time`/`end_time` are int32, but be explicit so a future int64
        // field arrives as a number rather than a Long object.
        longs: Number,
        enums: String,
        defaults: true,
        oneofs: true,
      });
      const pkg = grpc.loadPackageDefinition(definition) as unknown as {
        nvidia: { riva: { asr: { RivaSpeechRecognition: new (...args: never[]) => RivaServiceClient } } };
      };
      const Ctor = pkg.nvidia.riva.asr.RivaSpeechRecognition;
      return new Ctor(endpoint as never, grpc.credentials.createSsl() as never, {
        'grpc.max_send_message_length': MAX_MESSAGE_BYTES,
        'grpc.max_receive_message_length': MAX_MESSAGE_BYTES,
      } as never);
    })();
    clients.set(endpoint, clientPromise);
  }

  return { client: await clientPromise, grpc };
}

function buildMetadata(grpc: typeof import('@grpc/grpc-js'), raw: Readonly<Record<string, string>>) {
  const metadata = new grpc.Metadata();
  for (const [key, value] of Object.entries(raw)) metadata.set(key, value);
  return metadata;
}

async function openCall(options: RivaCallOptions): Promise<DuplexLike> {
  const { client, grpc } = await getClient(options.endpoint);
  const metadata = buildMetadata(grpc, options.metadata);
  return client.StreamingRecognize(metadata, { deadline: Date.now() + options.timeoutMs });
}

/**
 * Drive the duplex stream: write requests as they are produced, yield responses
 * as they arrive. Responses are buffered in a small queue rather than awaited
 * in lockstep, because Riva sends results while we are still uploading audio.
 */
async function* pump(
  call: DuplexLike,
  requests: AsyncIterable<RivaStreamingRequest>,
): AsyncGenerator<RivaStreamingResponse> {
  const queue: RivaStreamingResponse[] = [];
  let done = false;
  let failure: unknown;
  let wake: (() => void) | null = null;

  // Resolved once the call is over, however it ended. Anything that waits on
  // the stream races against this, so a dead call can never leave a pending
  // promise with nothing left to settle it.
  let finish: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const signal = () => {
    wake?.();
    wake = null;
  };

  call.on('data', (value) => {
    queue.push(value);
    signal();
  });
  call.on('end', () => {
    done = true;
    finish();
    signal();
  });
  call.on('error', (error) => {
    failure = error;
    done = true;
    finish();
    signal();
  });

  // Uploading runs alongside consumption. Its rejection is captured rather than
  // left floating; it is re-thrown below once the response side has drained.
  let writeFailure: unknown;
  const writing = (async () => {
    for await (const request of requests) {
      if (done) return;
      if (!call.write(request)) {
        // Respect backpressure: without this an hour of PCM queues up in the
        // channel's send buffer, which is exactly the memory we are avoiding.
        // Raced against `finished`, because a call that dies mid-upload will
        // never drain and the upload would otherwise wait forever.
        await Promise.race([new Promise<void>((resolve) => call.once('drain', resolve)), finished]);
      }
    }
    call.end();
  })().catch((error: unknown) => {
    writeFailure = error;
    call.destroy();
  });

  try {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) break;
      await Promise.race([
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
        finished,
      ]);
    }
    await writing;
    if (writeFailure !== undefined) throw writeFailure;
    if (failure !== undefined) throw toAiError(failure);
  } finally {
    call.destroy();
  }
}

// Values from grpc.status; inlined so this stays importable without gRPC.
const GRPC_STATUS_NAMES: Readonly<Record<number, string>> = {
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
};

const DEADLINE_EXCEEDED = 4;
const UNAVAILABLE = 14;
const UNAUTHENTICATED = 16;
const PERMISSION_DENIED = 7;

/** The NVCF request id, when the server's trailing metadata carried one — the handle NVIDIA support needs to look up a failure. */
function nvcfRequestId(error: unknown): string | undefined {
  const getMap = (error as { metadata?: { getMap?: () => Record<string, unknown> } })?.metadata?.getMap;
  const value = typeof getMap === 'function' ? getMap.call((error as { metadata: unknown }).metadata)['nvcf-reqid'] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/**
 * gRPC status codes, mapped onto the same error vocabulary the HTTP client
 * uses, so a caller handles an ASR failure exactly like a chat failure.
 *
 * NVCF's gateway frequently returns a status with an empty `details` string
 * (confirmed live: `INVALID_ARGUMENT` with no message when a request shape it
 * rejects reaches it) — falling back to `error.message` alone in that case
 * previously produced a message that trailed off after the colon with nothing
 * after it. The status *name* is always present, so it anchors the message
 * even when NVIDIA sends no text; the request id goes to `logDetails` only,
 * since it is a support handle, not something a client needs to see.
 */
/** Exported only for the mapping tests below — never call this outside the transport. */
export function toAiError(error: unknown): unknown {
  const status = (error as { code?: number })?.code;
  const statusName = status !== undefined ? (GRPC_STATUS_NAMES[status] ?? `code ${status}`) : 'no gRPC status';
  const rawDetail = (error as { details?: string })?.details;
  const detail = rawDetail && rawDetail.length > 0 ? rawDetail : ((error as Error)?.message ?? '');
  const reqId = nvcfRequestId(error);
  const logDetails = { detail: detail || '(empty)', ...(reqId ? { nvcfRequestId: reqId } : {}) };

  if (status === DEADLINE_EXCEEDED) {
    return aiError('provider_timeout', 'NVIDIA transcription did not respond in time.', { cause: error, logDetails });
  }
  if (status === UNAVAILABLE) {
    return aiError('provider_unreachable', 'Could not reach the NVIDIA transcription service.', {
      cause: error,
      logDetails,
    });
  }
  if (status === UNAUTHENTICATED || status === PERMISSION_DENIED) {
    return aiError(
      'provider_request_failed',
      `NVIDIA transcription rejected the credentials: ${statusName}${detail ? ` — ${detail}` : ''}`,
      { cause: error, details: { status, statusName }, logDetails },
    );
  }
  return aiError(
    'provider_request_failed',
    `NVIDIA transcription request failed: ${statusName}${detail ? ` — ${detail}` : ''}`,
    { cause: error, details: { status: status ?? null, statusName }, logDetails },
  );
}
