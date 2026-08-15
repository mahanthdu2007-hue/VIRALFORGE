/**
 * HTTP boundary helpers.
 *
 * Every route body runs inside `handleRoute`, so no error can escape as an
 * unstructured 500 and nothing is ever swallowed: unexpected failures are
 * logged with their stack and returned with a stable envelope.
 */

import { NextResponse } from 'next/server';
import { toAppError, type AppError, type ErrorKind } from './errors';
import type { Logger } from './logger';

export interface ApiErrorBody {
  readonly error: {
    readonly kind: ErrorKind;
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

export const jsonOk = <T>(data: T, status = 200): NextResponse<T> =>
  NextResponse.json(data, { status });

export const jsonError = (error: AppError): NextResponse<ApiErrorBody> =>
  NextResponse.json({ error: error.toJSON() }, { status: error.httpStatus });

/**
 * A route that exists but whose implementation belongs to a later phase.
 * 501 is deliberate: the client must not treat this as success.
 */
export const notImplemented = (feature: string, plannedPhase: string): NextResponse =>
  NextResponse.json(
    {
      error: {
        kind: 'processing' as const,
        code: 'not_implemented',
        message: `${feature} is not implemented yet.`,
        details: { feature, plannedPhase },
      },
    },
    { status: 501 },
  );

/** Wraps a route handler with logging and error normalisation. */
export async function handleRoute(
  logger: Logger,
  route: string,
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const startedAt = Date.now();
  try {
    const response = await handler();
    logger.debug('request completed', { route, status: response.status, ms: Date.now() - startedAt });
    return response;
  } catch (error) {
    const app = toAppError(error);
    const context = { route, kind: app.kind, code: app.code, ms: Date.now() - startedAt };

    if (app.kind === 'unexpected' || app.httpStatus >= 500) {
      logger.error('request failed', error, context);
    } else {
      // 4xx are expected traffic — no stack — but diagnostics withheld from the
      // response body (paths, raw stderr) still have to reach the log.
      logger.warn('request rejected', {
        ...context,
        ...(app.logDetails ? { logDetails: app.logDetails } : {}),
      });
    }

    return jsonError(app);
  }
}
