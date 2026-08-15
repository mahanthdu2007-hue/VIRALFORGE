/**
 * Minimal OpenAI HTTP client.
 *
 * Deliberately not the official SDK: we use two endpoints, and a hand-rolled
 * client keeps the dependency tree small and makes the adapter testable by
 * injecting `fetch`. No OpenAI type ever escapes this directory.
 */

import { aiError } from '@/lib/errors';

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

  private async send<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.options.apiKey}`, ...(init.headers ?? {}) },
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw aiError(
        aborted ? 'provider_timeout' : 'provider_unreachable',
        aborted ? 'The AI provider did not respond in time.' : 'Could not reach the AI provider.',
        { cause: error, details: { path } },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await readErrorMessage(response);
      throw aiError('provider_request_failed', `${this.providerLabel} request failed: ${detail}`, {
        details: { path, status: response.status },
        logDetails: { detail },
      });
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw aiError('provider_response_unparseable', 'The AI provider returned a body that is not JSON.', {
        cause: error,
        details: { path },
      });
    }
  }
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
