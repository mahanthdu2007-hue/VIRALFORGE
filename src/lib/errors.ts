/**
 * Error taxonomy for ViralForge.
 *
 * Every failure the system raises deliberately is an `AppError` carrying a
 * `kind`. The kind decides two things and nothing else: the HTTP status the API
 * layer returns, and whether the failure is the caller's fault or ours.
 * `unexpected` is reserved for anything we did not anticipate — it is never
 * thrown on purpose, only wrapped.
 */

export const ERROR_KINDS = [
  'validation',
  'media',
  'ai',
  'processing',
  'rendering',
  'not_found',
  'unexpected',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

/** Machine-readable detail bag attached to an error. Must stay serialisable. */
export type ErrorDetails = Record<string, unknown>;

export interface AppErrorOptions {
  /** Safe to return to the caller. */
  details?: ErrorDetails;
  /** Logged only — for anything a client should not see (paths, raw stderr). */
  logDetails?: ErrorDetails;
  cause?: unknown;
}

const STATUS_BY_KIND: Record<ErrorKind, number> = {
  validation: 400,
  not_found: 404,
  media: 422,
  ai: 502,
  processing: 500,
  rendering: 500,
  unexpected: 500,
};

/**
 * Realm-safe brand.
 *
 * `instanceof` is not reliable here: the Next dev server compiles each route
 * into its own module graph, so a service cached on `globalThis` (see
 * `src/runtime.ts`) throws errors built from a *different* copy of this class
 * than the route catching them. A registered symbol is shared across all copies.
 */
const APP_ERROR_BRAND = Symbol.for('viralforge.AppError');

export class AppError extends Error {
  readonly [APP_ERROR_BRAND] = true;
  readonly kind: ErrorKind;
  readonly code: string;
  /** Client-safe. Serialised into API responses. */
  readonly details: ErrorDetails | undefined;
  /** Diagnostic-only: logged, never sent over the wire. */
  readonly logDetails: ErrorDetails | undefined;
  readonly httpStatus: number;

  constructor(kind: ErrorKind, code: string, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = `${kind[0]!.toUpperCase()}${kind.slice(1)}Error`;
    this.kind = kind;
    this.code = code;
    this.details = options.details;
    this.logDetails = options.logDetails;
    this.httpStatus = STATUS_BY_KIND[kind];
  }

  /**
   * Wire shape. Excludes `logDetails`, stack and cause, so absolute paths and
   * raw subprocess output cannot escape to a client.
   */
  toJSON(): { kind: ErrorKind; code: string; message: string; details?: ErrorDetails } {
    return {
      kind: this.kind,
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Constructors — one per conceptual category.                                */
/* -------------------------------------------------------------------------- */

type Opts = AppErrorOptions;

/** Caller sent something we cannot accept (bad body, unsupported file type). */
export const validationError = (code: string, message: string, o?: Opts) =>
  new AppError('validation', code, message, o ?? {});

/** The media file or the media toolchain is the problem (FFmpeg, probe, codec). */
export const mediaError = (code: string, message: string, o?: Opts) =>
  new AppError('media', code, message, o ?? {});

/** An AI provider failed, refused, or returned an unusable response. */
export const aiError = (code: string, message: string, o?: Opts) =>
  new AppError('ai', code, message, o ?? {});

/** A pipeline stage (analysis, transcription, clip selection) failed. */
export const processingError = (code: string, message: string, o?: Opts) =>
  new AppError('processing', code, message, o ?? {});

/** The final encode/mux step failed. */
export const renderingError = (code: string, message: string, o?: Opts) =>
  new AppError('rendering', code, message, o ?? {});

/** A referenced entity does not exist. */
export const notFoundError = (code: string, message: string, o?: Opts) =>
  new AppError('not_found', code, message, o ?? {});

/** Phase guard: the route/feature exists but its implementation lands later. */
export const notImplementedError = (feature: string, phase: string) =>
  new AppError('processing', 'not_implemented', `${feature} is not implemented yet.`, {
    details: { feature, plannedPhase: phase },
  });

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

export const isAppError = (value: unknown): value is AppError =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<symbol, unknown>)[APP_ERROR_BRAND] === true;

/**
 * Turn an unknown thrown value into an `AppError` without losing the original.
 * Used at every boundary (API routes, job runners) so nothing escapes untyped.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;

  if (value instanceof Error) {
    return new AppError('unexpected', 'unexpected_error', value.message, { cause: value });
  }

  return new AppError('unexpected', 'unexpected_error', 'An unexpected error occurred.', {
    details: { thrown: String(value) },
  });
}
