/**
 * Subject tracking — the interface, not an implementation.
 *
 * A tracker answers one question: *where in the frame is the thing worth
 * looking at, over time?* It knows nothing about FFmpeg, crop geometry, AI
 * providers, transcripts or clip scores, and none of those know about it. What
 * connects them is `SubjectObservation`, a plain timestamped rectangle — a
 * face detector, a saliency model, a hand-written fixture and the deterministic
 * tracker in this folder all speak it.
 *
 * That separation is the point of the phase. Framing quality then improves by
 * swapping the tracker, never by touching the renderer or the crop maths.
 */

import type { Dimensions, TimeRange } from '@/domain';

/** A subject the tracker believes it has located at one instant. */
export interface SubjectObservation {
  /** Seconds on the **source** timeline, inside the requested range. */
  readonly atSec: number;
  /** Subject bounding box in source pixels; the origin is the top-left corner. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 0..1. Anything the caller finds unconvincing it is free to discard. */
  readonly confidence: number;
  /**
   * Stable across observations of the same subject, so a future multi-speaker
   * tracker can be followed selectively. Null when the tracker does not
   * distinguish subjects.
   */
  readonly subjectId: string | null;
}

export interface TrackingRequest {
  /** Absolute path to the source video. Read-only; never modified. */
  readonly videoPath: string;
  /** The span of the source to track, in source-timeline seconds. */
  readonly range: TimeRange;
  /** Frame size the observations are expressed in. */
  readonly source: Dimensions;
  /**
   * Requested spacing between observations, in seconds. A tracker may return
   * fewer (it found nothing) or differently spaced ones; the crop path
   * resamples regardless.
   */
  readonly intervalSec?: number;
}

export interface TrackingResult {
  /** Ascending by `atSec`. May be empty: "I found nothing" is a valid answer. */
  readonly observations: readonly SubjectObservation[];
  /** Which tracker produced this, for provenance in logs and stored plans. */
  readonly trackerId: string;
}

export interface SubjectTracker {
  readonly id: string;
  /**
   * Locate the subject over `request.range`.
   *
   * Must not throw for a video it cannot make sense of — an empty observation
   * list is how a tracker says so, and the crop path falls back to a centre
   * crop. Reserve throwing for a genuinely broken request.
   */
  track(request: TrackingRequest): Promise<TrackingResult>;
}

/** Centre point of an observation, in source pixels. */
export const observationCenter = (
  observation: Pick<SubjectObservation, 'x' | 'y' | 'width' | 'height'>,
): { readonly x: number; readonly y: number } => ({
  x: observation.x + observation.width / 2,
  y: observation.y + observation.height / 2,
});

/** Whether an observation is usable geometry rather than noise or NaN. */
export const isUsableObservation = (
  observation: SubjectObservation,
  source: Dimensions,
): boolean =>
  Number.isFinite(observation.atSec) &&
  Number.isFinite(observation.x) &&
  Number.isFinite(observation.y) &&
  Number.isFinite(observation.width) &&
  Number.isFinite(observation.height) &&
  Number.isFinite(observation.confidence) &&
  observation.width > 0 &&
  observation.height > 0 &&
  observation.confidence >= 0 &&
  observation.confidence <= 1 &&
  // A box wholly outside the frame is a tracker bug, not a subject.
  observation.x + observation.width > 0 &&
  observation.y + observation.height > 0 &&
  observation.x < source.width &&
  observation.y < source.height;
