/**
 * Trackers that need no model, no GPU and no luck.
 *
 * `CenterSubjectTracker` is the development default: it reports a subject
 * sitting in the middle of the frame for the whole range. That sounds useless
 * until you notice what it buys — the entire path from tracker to crop plan is
 * exercised end to end, deterministically, with no dependency to install and no
 * inference to wait for. When a real detector lands, it replaces this object
 * and nothing else changes.
 *
 * `FixtureSubjectTracker` replays a scripted list of observations, which is how
 * a *moving* subject is tested without a moving picture.
 *
 * Neither opens the video file. That is deliberate: nothing downstream may
 * assume a tracker did, because a tracker that finds nothing must be as
 * ordinary a case as one that does.
 */

import type {
  SubjectObservation,
  SubjectTracker,
  TrackingRequest,
  TrackingResult,
} from './types';

/** Default spacing between observations. Twice a second is plenty for panning. */
export const DEFAULT_TRACK_INTERVAL_SEC = 0.5;

/** Fraction of the frame the imagined subject occupies. Portrait-ish, like a person. */
const SUBJECT_WIDTH_FRACTION = 0.25;
const SUBJECT_HEIGHT_FRACTION = 0.6;

export interface CenterSubjectTrackerOptions {
  readonly intervalSec?: number;
  /** Reported for every observation. Fixed, because nothing here is uncertain. */
  readonly confidence?: number;
  readonly subjectId?: string | null;
}

export class CenterSubjectTracker implements SubjectTracker {
  readonly id = 'center';

  constructor(private readonly options: CenterSubjectTrackerOptions = {}) {}

  async track(request: TrackingRequest): Promise<TrackingResult> {
    const interval = positiveInterval(request.intervalSec ?? this.options.intervalSec);
    const width = evenRound(request.source.width * SUBJECT_WIDTH_FRACTION);
    const height = evenRound(request.source.height * SUBJECT_HEIGHT_FRACTION);

    const observations = sampleTimes(request, interval).map((atSec) => ({
      atSec,
      x: (request.source.width - width) / 2,
      y: (request.source.height - height) / 2,
      width,
      height,
      confidence: this.options.confidence ?? 1,
      subjectId: this.options.subjectId ?? null,
    }));

    return { observations, trackerId: this.id };
  }
}

export interface FixtureSubjectTrackerOptions {
  readonly id?: string;
  /**
   * Observations on the **source** timeline. Those outside the requested range
   * are dropped, so one fixture can serve several clips of the same video.
   */
  readonly observations: readonly SubjectObservation[];
}

export class FixtureSubjectTracker implements SubjectTracker {
  readonly id: string;

  constructor(private readonly options: FixtureSubjectTrackerOptions) {
    this.id = options.id ?? 'fixture';
  }

  async track(request: TrackingRequest): Promise<TrackingResult> {
    const observations = this.options.observations
      .filter((o) => o.atSec >= request.range.startSec && o.atSec <= request.range.endSec)
      .slice()
      .sort((a, b) => a.atSec - b.atSec);

    return { observations, trackerId: this.id };
  }
}

/** A tracker that never finds anything. The centre-crop fallback path, on demand. */
export class NullSubjectTracker implements SubjectTracker {
  readonly id = 'null';

  // Takes no request: there is nothing about one it could use.
  async track(): Promise<TrackingResult> {
    return { observations: [], trackerId: this.id };
  }
}

/* -------------------------------------------------------------------------- */

/** Sample instants across the range, always including both ends exactly once. */
function sampleTimes(request: TrackingRequest, intervalSec: number): number[] {
  const { startSec, endSec } = request.range;
  if (!(endSec > startSec)) return [];

  const times: number[] = [];
  for (let t = startSec; t < endSec; t += intervalSec) times.push(round6(t));

  const last = times[times.length - 1];
  if (last === undefined || last < endSec) times.push(round6(endSec));

  return times;
}

const positiveInterval = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TRACK_INTERVAL_SEC;

/** Keeps accumulated floating-point error out of the timestamps. */
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

const evenRound = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
