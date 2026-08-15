/** Shared primitives used across the domain. Deliberately tiny. */

/** Nominal typing so a VideoId can never be passed where a JobId is expected. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** ISO-8601 UTC timestamp, e.g. `2026-08-11T10:04:00.000Z`. */
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

export const nowIso = (): IsoTimestamp => new Date().toISOString() as IsoTimestamp;

/** Half-open interval on a media timeline, in seconds from the start. */
export interface TimeRange {
  readonly startSec: number;
  readonly endSec: number;
}

export const rangeDuration = (range: TimeRange): number => range.endSec - range.startSec;

export const isValidRange = (range: TimeRange): boolean =>
  Number.isFinite(range.startSec) &&
  Number.isFinite(range.endSec) &&
  range.startSec >= 0 &&
  range.endSec > range.startSec;

export const rangesOverlap = (a: TimeRange, b: TimeRange): boolean =>
  a.startSec < b.endSec && b.startSec < a.endSec;

/** Normalised 0..1 score. Kept as a plain number; validated at the edges. */
export type UnitScore = number;

export const isUnitScore = (value: unknown): value is UnitScore =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Generates entity identifiers. Wrapped so tests can inject a fixed sequence. */
export type IdFactory = () => string;

export const uuidFactory: IdFactory = () => crypto.randomUUID();
