/**
 * Minimal OpenAI HTTP client.
 *
 * Deliberately not the official SDK: we use two endpoints, and a hand-rolled
 * client keeps the dependency tree small and makes the adapter testable by
 * injecting `fetch`. No OpenAI type ever escapes this directory.
 */

import { aiError } from '@/lib/errors';
import { assembleSseCompletion } from './stream';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Injected in tests; defaults to the platform `fetch`. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAiClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Named in error messages. Defaults to 'OpenAI' so existing callers are unaffected. */
  readonly providerLabel?: string;
}

/**
 * Speaks the OpenAI chat-completions wire format, which any OpenAI-compatible
 * endpoint (NVIDIA's included) also speaks. `providerLabel` only changes error
 * text; the request/response shape is identical either way.
 */
export class OpenAiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly providerLabel: string;

  constructor(private readonly options: OpenAiClientOptions) {
    this.baseUrl = options.baseUrl ?? OPENAI_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    // Transcribing an hour of audio legitimately takes minutes.
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.providerLabel = options.providerLabel ?? 'OpenAI';
  }

  postJson<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** `FormData` carrying a `Blob` streams from disk rather than buffering. */
  postForm<T>(path: string, form: FormData): Promise<T> {
    return this.send<T>(path, { method: 'POST', body: form });
  }

  /**
   * Chat completion over `stream: true`.
   *
   * Returns the same object shape the non-streaming endpoint returns — the SSE
   * deltas are reassembled into one `choices[0].message.content` — so callers
   * parse the result exactly as before. Used by NVIDIA discovery, whose gateway
   * times a long non-streaming generation out at its own deadline.
   *
   * A server that ignores `stream` and answers with a plain JSON body is
   * handled too: that body is returned unchanged.
   */
  async postJsonStream<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const { response, release } = await this.open(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ ...body, stream: true }),
    });

    try {
      if (!isEventStream(response)) return (await this.readJson<T>(response, path)) as T;
      return (await assembleSseCompletion(response.body, path)) as T;
    } catch (error) {
      throw this.streamFailure(error, path);
    } finally {
      release();
    }
  }

  private async send<T>(path: string, init: RequestInit): Promise<T> {
    const { response, release } = await this.open(path, init);
    try {
      return await this.readJson<T>(response, path);
    } finally {
      release();
    }
  }

  /**
   * Perform the request and hand back an OK response.
   *
   * The abort timer stays armed until `release()` is called, so it covers
   * reading the body as well as receiving the headers — a stalled stream is
   * still subject to the same `timeoutMs`, never a longer one.
   *
   * @throws AppError kind=ai on transport failure, timeout or a non-2xx status
   */
  private async open(path: string, init: RequestInit): Promise<{ response: Response; release: () => void }> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const release = () => clearTimeout(timer);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.options.apiKey}`, ...(init.headers ?? {}) },
      });
    } catch (error) {
      release();
      throw transportError(error, path);
    }

    if (!response.ok) {
      release();
      const detail = await readErrorMessage(response);
      throw aiError('provider_request_failed', `${this.providerLabel} request failed: ${detail}`, {
        details: { path, status: response.status },
        logDetails: { detail },
      });
    }

    return { response, release };
  }

  private async readJson<T>(response: Response, path: string): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw aiError('provider_response_unparseable', 'The AI provider returned a body that is not JSON.', {
        cause: error,
        details: { path },
      });
    }
  }

  /** Errors raised while draining the stream, mapped like request errors. */
  private streamFailure(error: unknown, path: string): unknown {
    if (isAppError(error)) return error;
    return transportError(error, path);
  }
}

/** An `AppError` from any copy of the module — see the brand in `lib/errors`. */
function isAppError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Symbol.for('viralforge.AppError') in error;
}

function transportError(error: unknown, path: string): unknown {
  const aborted = error instanceof Error && error.name === 'AbortError';
  return aiError(
    aborted ? 'provider_timeout' : 'provider_unreachable',
    aborted ? 'The AI provider did not respond in time.' : 'Could not reach the AI provider.',
    { cause: error, details: { path } },
  );
}

/** Only a `text/event-stream` body is parsed as SSE; anything else is JSON. */
function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
}

/** Best-effort extraction of the provider's error message; never throws. */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      return parsed.error?.message ?? `HTTP ${response.status}`;
    } catch {
      return text.slice(0, 500) || `HTTP ${response.status}`;
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}
