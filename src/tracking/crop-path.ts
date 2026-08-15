/**
 * Tracking observations → a crop path.
 *
 * One pure function, `buildCropPath`, and the reason it is worth its own module
 * is that "point the crop at the subject" is not the hard part. The hard parts
 * are all the ways a naive version looks wrong on screen:
 *
 *  - **Jitter.** A detector's box wobbles a few pixels per frame. Following it
 *    exactly produces a picture that shakes. Smoothing is not polish here; it
 *    is the difference between watchable and unwatchable.
 *  - **Whip pans.** Two subjects, alternating detections, and the frame slams
 *    left and right. A velocity limit makes the camera physically incapable of
 *    that, whatever the observations claim.
 *  - **Losing the subject.** Smoothing lags; a lagging window can leave the
 *    speaker's head half out of frame. So containment is applied *after*
 *    smoothing, and wins over it.
 *  - **Gaps and doubt.** Missing stretches, low-confidence guesses and an empty
 *    result must all degrade to something safe rather than to something odd.
 *    The floor is the centre crop from the previous phase.
 *
 * The pipeline is: filter → resample onto a uniform grid → smooth (zero-phase)
 * → limit velocity → contain the subject → clamp to the frame → collapse to
 * keyframes. Deterministic throughout: no clocks, no randomness, integer
 * output.
 */

import {
  clamp,
  clampCropWindow,
  largestCenteredWindow,
  planCenterCrop,
  SHORTS_OUTPUT,
  aspectRatio,
  type CropKeyframe,
  type CropPlan,
  type Dimensions,
  type TimeRange,
} from '@/domain';
import { validationError } from '@/lib/errors';
import { isUsableObservation, type SubjectObservation } from './types';

export interface CropPathOptions {
  readonly source: Dimensions;
  /** Finished frame. Defaults to 1080×1920; fixes the crop window's ratio. */
  readonly output?: Dimensions;
  /** The clip's span on the **source** timeline. Keyframes come out clip-relative. */
  readonly range: TimeRange;
  /** Observations below this are treated as absent. */
  readonly minConfidence?: number;
  /** Spacing of the resampled path, in seconds. */
  readonly sampleIntervalSec?: number;
  /** Time for the camera to cover half the distance to a new target. */
  readonly smoothingHalfLifeSec?: number;
  /** Ceiling on pan speed, as a fraction of the source width per second. */
  readonly maxPanFractionPerSec?: number;
  /** Recorded on the plan's rationale for provenance. */
  readonly trackerId?: string | null;
}

export const CROP_PATH_DEFAULTS = {
  minConfidence: 0.4,
  sampleIntervalSec: 0.5,
  smoothingHalfLifeSec: 0.9,
  maxPanFractionPerSec: 0.12,
} as const;

/**
 * Turn observations into a crop plan.
 *
 * Falls back to a static centre crop whenever tracking has nothing trustworthy
 * to say — no observations, all of them below the confidence floor, or a range
 * with no duration. The fallback is a normal outcome, not an error, and is
 * marked as such on the keyframe's `confidence` and the plan's rationale.
 *
 * @throws AppError kind=validation only when the geometry itself is impossible
 *         (unusable dimensions, or a source too small for the target ratio).
 */
export function buildCropPath(
  observations: readonly SubjectObservation[],
  options: CropPathOptions,
): CropPlan {
  const source = options.source;
  const output = options.output ?? SHORTS_OUTPUT;
  const fallback = centerFallback(source, output, options.trackerId ?? null);

  const window = largestCenteredWindow(source, output);
  const durationSec = options.range.endSec - options.range.startSec;
  if (!window || !(durationSec > 0)) return fallback;

  const minConfidence = options.minConfidence ?? CROP_PATH_DEFAULTS.minConfidence;
  const interval = positive(options.sampleIntervalSec, CROP_PATH_DEFAULTS.sampleIntervalSec);
  const halfLife = positive(options.smoothingHalfLifeSec, CROP_PATH_DEFAULTS.smoothingHalfLifeSec);
  const maxPanPxPerSec =
    positive(options.maxPanFractionPerSec, CROP_PATH_DEFAULTS.maxPanFractionPerSec) * source.width;

  // Clip-relative, confident, in-range, in ascending order. Anything that fails
  // any of those is simply not evidence.
  const usable = observations
    .filter((o) => isUsableObservation(o, source))
    .filter((o) => o.confidence >= minConfidence)
    .filter((o) => o.atSec >= options.range.startSec && o.atSec <= options.range.endSec)
    .map((o) => ({ ...o, atSec: o.atSec - options.range.startSec }))
    .sort((a, b) => a.atSec - b.atSec);

  if (usable.length === 0) return fallback;

  const times = sampleGrid(durationSec, interval);
  // Held flat outside the observed span rather than extrapolated: a tracker
  // that stopped reporting is not evidence that the subject kept moving.
  const samples = times.map((atSec) => interpolateObservation(usable, atSec));

  const centreX = smoothSeries(samples.map((s) => s.x + s.width / 2), times, halfLife);
  const centreY = smoothSeries(samples.map((s) => s.y + s.height / 2), times, halfLife);

  // Containment adjusts the *target*, and the velocity limit then decides how
  // much of that target is reachable this step. The other order — contain after
  // limiting — lets a subject that teleports drag the window with it, which is
  // precisely the whip pan the limit exists to prevent. Framing a subject is
  // "when possible"; not lurching is unconditional.
  const targetX = centreX.map((c, i) =>
    containAxis(c - window.width / 2, samples[i]!.x, samples[i]!.width, window.width),
  );
  const targetY = centreY.map((c, i) =>
    containAxis(c - window.height / 2, samples[i]!.y, samples[i]!.height, window.height),
  );

  const pathX = limitVelocity(targetX, times, maxPanPxPerSec);
  const pathY = limitVelocity(targetY, times, maxPanPxPerSec);

  const keyframes: CropKeyframe[] = times.map((atSec, i) => {
    const sample = samples[i]!;
    const window_ = { x: pathX[i]!, y: pathY[i]!, width: window.width, height: window.height };

    return {
      atSec,
      ...clampCropWindow(window_, source),
      confidence: round4(sample.confidence),
      subjectId: sample.subjectId,
    };
  });

  const collapsed = collapse(keyframes);

  // A path that never actually moves is a static plan, and saying so keeps the
  // renderer on its simplest path.
  if (collapsed.length === 1) {
    return {
      strategy: 'static',
      source,
      output,
      targetAspectRatio: aspectRatio(output),
      keyframes: [{ ...collapsed[0]!, atSec: 0 }],
      rationale: rationale('static', usable.length, options.trackerId ?? null),
    };
  }

  return {
    strategy: 'tracked',
    source,
    output,
    targetAspectRatio: aspectRatio(output),
    keyframes: collapsed,
    rationale: rationale('tracked', usable.length, options.trackerId ?? null),
  };
}

/** The safe floor: a static centre crop, marked as un-tracked. */
export function centerFallback(
  source: Dimensions,
  output: Dimensions = SHORTS_OUTPUT,
  trackerId: string | null = null,
): CropPlan {
  const result = planCenterCrop({ source, output });

  if (!result.ok) {
    throw validationError(result.reason, 'The source cannot be cropped to the target aspect ratio.', {
      details: { source, output },
    });
  }

  return {
    ...result.plan,
    keyframes: result.plan.keyframes.map((kf) => ({ ...kf, confidence: 0, subjectId: null })),
    rationale: rationale('fallback', 0, trackerId),
  };
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                      */
/* -------------------------------------------------------------------------- */

/** Uniform instants across the clip, both ends included exactly once. */
function sampleGrid(durationSec: number, intervalSec: number): number[] {
  const times: number[] = [];
  for (let t = 0; t < durationSec; t += intervalSec) times.push(round6(t));

  const last = times[times.length - 1];
  if (last === undefined || last < durationSec) times.push(round6(durationSec));

  return times;
}

type Sample = Pick<SubjectObservation, 'x' | 'y' | 'width' | 'height' | 'confidence' | 'subjectId'>;

/**
 * The subject at one instant, linear between observations.
 *
 * Missing stretches are bridged by interpolation and the ends are held, which
 * is what makes a sparse or gappy tracker usable without special-casing.
 */
function interpolateObservation(
  observations: readonly (SubjectObservation & { atSec: number })[],
  atSec: number,
): Sample {
  const first = observations[0]!;
  const last = observations[observations.length - 1]!;
  if (atSec <= first.atSec) return first;
  if (atSec >= last.atSec) return last;

  for (let i = 1; i < observations.length; i += 1) {
    const to = observations[i]!;
    if (atSec > to.atSec) continue;

    const from = observations[i - 1]!;
    const span = to.atSec - from.atSec;
    const t = span > 0 ? (atSec - from.atSec) / span : 1;

    return {
      x: lerp(from.x, to.x, t),
      y: lerp(from.y, to.y, t),
      width: lerp(from.width, to.width, t),
      height: lerp(from.height, to.height, t),
      // Interpolated too, so a keyframe bridging a gap reads as less certain
      // than one sitting on an observation.
      confidence: lerp(from.confidence, to.confidence, t),
      // Identity does not interpolate; the nearer observation owns the sample.
      subjectId: t < 0.5 ? from.subjectId : to.subjectId,
    };
  }

  return last;
}

/**
 * Exponential smoothing, run forwards and then backwards.
 *
 * A single pass lags the subject by roughly the half-life — the camera is
 * always behind. Running the same filter over the reversed series cancels that
 * lag (the standard zero-phase trick) at the cost of the result depending on
 * the whole series, which is free here because the path is computed offline.
 */
function smoothSeries(values: readonly number[], times: readonly number[], halfLifeSec: number): number[] {
  const forward = emaPass(values, times);
  const backward = emaPass([...forward].reverse(), [...times].reverse().map((t) => -t));
  return backward.reverse();

  function emaPass(series: readonly number[], stamps: readonly number[]): number[] {
    const out: number[] = [];
    let current = series[0] ?? 0;

    for (const [i, value] of series.entries()) {
      if (i === 0) {
        out.push(current);
        continue;
      }

      const dt = Math.abs(stamps[i]! - stamps[i - 1]!);
      // Half-life form, so the smoothing is the same regardless of sample rate.
      const alpha = 1 - Math.pow(0.5, dt / halfLifeSec);
      current += (value - current) * alpha;
      out.push(current);
    }

    return out;
  }
}

/** Cap how far the window may travel between samples. */
function limitVelocity(values: readonly number[], times: readonly number[], maxPxPerSec: number): number[] {
  const out: number[] = [];
  let previous = values[0] ?? 0;

  for (const [i, value] of values.entries()) {
    if (i === 0) {
      out.push(previous);
      continue;
    }

    const dt = Math.abs(times[i]! - times[i - 1]!);
    const maxStep = maxPxPerSec * dt;
    previous += clamp(value - previous, -maxStep, maxStep);
    out.push(previous);
  }

  return out;
}

/**
 * Nudge a target so the subject is inside the window, if the subject fits.
 *
 * The smoothed camera is allowed to lag; this stops the lag from cutting the
 * subject off, as far as the velocity limit downstream permits. A subject wider
 * than the window cannot be contained, so it is centred instead.
 */
function containAxis(
  position: number,
  subjectStart: number,
  subjectSize: number,
  windowSize: number,
): number {
  if (subjectSize >= windowSize) return subjectStart + subjectSize / 2 - windowSize / 2;

  const latest = subjectStart; // window may start no later than the subject
  const earliest = subjectStart + subjectSize - windowSize; // nor end before it
  return clamp(position, earliest, latest);
}

/**
 * Drop keyframes that say nothing new.
 *
 * Linear interpolation makes a keyframe identical to both neighbours
 * redundant, and a plan of 60 identical windows is noise in storage and in the
 * UI. The first and last are always kept: they anchor the held ends.
 */
function collapse(keyframes: readonly CropKeyframe[]): CropKeyframe[] {
  if (keyframes.length <= 2) return dedupeStill(keyframes);

  const kept: CropKeyframe[] = [keyframes[0]!];

  for (let i = 1; i < keyframes.length - 1; i += 1) {
    const previous = keyframes[i - 1]!;
    const current = keyframes[i]!;
    const next = keyframes[i + 1]!;
    const redundant =
      previous.x === current.x && current.x === next.x && previous.y === current.y && current.y === next.y;

    if (!redundant) kept.push(current);
  }

  kept.push(keyframes[keyframes.length - 1]!);
  return dedupeStill(kept);
}

/** A path with one distinct window is a still frame; keep only the first. */
const dedupeStill = (keyframes: readonly CropKeyframe[]): CropKeyframe[] =>
  keyframes.every((kf) => kf.x === keyframes[0]!.x && kf.y === keyframes[0]!.y)
    ? [keyframes[0]!]
    : [...keyframes];

/* -------------------------------------------------------------------------- */

const rationale = (kind: 'tracked' | 'static' | 'fallback', observations: number, trackerId: string | null) => {
  const by = trackerId ? ` by "${trackerId}"` : '';

  if (kind === 'fallback') return `Centre crop: no confident subject was tracked${by}.`;
  if (kind === 'static') return `Centre-weighted crop: the subject tracked${by} did not move.`;
  return `Crop follows the subject tracked${by} across ${observations} observations.`;
};

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

const positive = (value: number | undefined, fallbackValue: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallbackValue;

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;
