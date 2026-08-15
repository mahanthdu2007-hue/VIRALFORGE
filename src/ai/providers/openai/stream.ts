/**
 * Server-sent-event reading for OpenAI-compatible chat completions.
 *
 * Streaming exists for one reason: NVIDIA's gateway enforces a response
 * deadline (~302s) on a non-streaming request and returns HTTP 504 while the
 * model is still generating. A streamed response starts emitting bytes almost
 * immediately, so the gateway deadline is never reached.
 *
 * Nothing downstream knows about streaming: the deltas are reassembled here
 * into the exact object shape the non-streaming endpoint returns, which is what
 * `extractJsonContent` already parses. Only the generated completion text is
 * held in memory — the HTTP body is consumed event by event, never buffered
 * whole.
 */

import { aiError } from '@/lib/errors';

const DONE_SENTINEL = '[DONE]';

/** The reassembled completion. Deliberately shaped like a non-streamed one. */
export interface AssembledCompletion {
  readonly choices: readonly [{ message: { content: string }; finish_reason: string | null }];
}

/**
 * Yields the `data:` payload of each SSE event in order.
 *
 * Holds at most one unterminated event in memory. Comments (`: keep-alive`),
 * unknown fields (`event:`, `id:`) and events carrying no `data:` line are
 * skipped, per the SSE spec.
 */
export async function* readSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer = normalise(buffer + decoder.decode(value, { stream: true }));

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = dataOf(event);
        if (data !== null) yield data;
        boundary = buffer.indexOf('\n\n');
      }
    }

    // A well-behaved server terminates the last event with a blank line, but a
    // final event flushed without one still carries content.
    const tail = dataOf(normalise(buffer + decoder.decode()));
    if (tail !== null) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already finished or errored; nothing left to release.
    }
  }
}

/**
 * Read an SSE chat-completion stream to its end and return it as one completion.
 *
 * @throws AppError kind=ai when a chunk is not JSON, or when the stream ends
 * before the model signalled that it had finished.
 */
export async function assembleSseCompletion(
  body: ReadableStream<Uint8Array> | null,
  path: string,
): Promise<AssembledCompletion> {
  let content = '';
  let finishReason: string | null = null;
  let terminated = false;

  if (body) {
    for await (const data of readSseData(body)) {
      if (data === DONE_SENTINEL) {
        terminated = true;
        break;
      }

      const chunk = parseChunk(data, path);
      if (chunk.content) content += chunk.content;
      if (chunk.finishReason !== null) {
        finishReason = chunk.finishReason;
        terminated = true;
      }
    }
  }

  if (!terminated) {
    throw aiError('provider_response_truncated', 'The AI provider ended the stream before the response was complete.', {
      details: { path },
      logDetails: { received: content.length },
    });
  }

  return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

/** One `data:` payload, reduced to the two fields that matter. */
function parseChunk(data: string, path: string): { content: string; finishReason: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw aiError('provider_response_unparseable', 'The AI provider sent a streaming chunk that is not JSON.', {
      cause: error,
      details: { path },
      logDetails: { chunk: data.slice(0, 500) },
    });
  }

  // Chunks that carry only usage stats, an empty `choices` array, or fields we
  // do not use are legal and simply contribute nothing.
  const choice = firstChoice(parsed);
  if (!choice) return { content: '', finishReason: null };

  const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : null;
  const text = delta && typeof delta.content === 'string' ? delta.content : '';
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;

  return { content: text, finishReason };
}

function firstChoice(parsed: unknown): Record<string, unknown> | null {
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return null;
  const first: unknown = parsed.choices[0];
  return isRecord(first) ? first : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** CRLF and bare CR are valid SSE line breaks; normalise so one split works. */
function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** The concatenated `data:` lines of one event, or null when it has none. */
function dataOf(event: string): string | null {
  let data: string | null = null;

  for (const line of event.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;

    const value = line.slice(5).replace(/^ /, '');
    data = data === null ? value : `${data}\n${value}`;
  }

  return data;
}
