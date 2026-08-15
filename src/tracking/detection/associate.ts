/**
 * Boxes per frame → one subject over time.
 *
 * A detector answers "what is in this picture" and has no memory. Everything
 * that makes tracking hard lives in the gap between that and "where is the
 * speaker over these thirty seconds":
 *
 *  - **Two people.** Both are detected in every frame. Picking per-frame
 *    whichever box scored higher produces a crop that flips between them; the
 *    only stable answer is to build a track per person and choose *once*.
 *  - **Blinking detections.** A face turns, a hand crosses it, one frame comes
 *    back empty. Ending the track there and starting a new one on the next
 *    frame would hand the crop path a subject identity that changes every
 *    second. So a track survives a bounded gap.
 *  - **Someone walks in.** A new box that matches nothing is a new subject, not
 *    a jump of an existing one — which is why matching is gated on overlap,
 *    proximity *and* similar size rather than on nearest-box-wins.
 *  - **Not knowing.** A subject seen in three frames out of forty is not a
 *    subject the camera should follow. Below a coverage floor this returns
 *    nothing, which is how the crop path is told to use its centre-crop
 *    fallback.
 *
 * Pure and deterministic: same detections in, same track out, no clock, no
 * randomness, ties broken by geometry rather than by array order.
 */

import type { Dimensions } from '@/domain';
import type { SubjectObservation } from '../types';
import { iou, type DetectionFrame, type FrameDetection } from './types';

export interface SubjectTrack {
  readonly subjectId: string;
  readonly observations: readonly SubjectObservation[];
  /** Σ confidence × √(area fraction) — presence, not peak confidence. */
  readonly score: number;
}

export interface AssociateOptions {
  /** Frame size the detections are expressed in. */
  readonly source: Dimensions;
  /** Detections below this never enter a track. */
  readonly minConfidence?: number;
  /** How long a track may go unmatched before it is closed. */
  readonly maxGapSec?: number;
  /** Overlap that continues a track outright. */
  readonly matchIouThreshold?: number;
  /**
   * Centre movement, as a fraction of the source width, that continues a track
   * even with no overlap. Small fast-moving boxes stop overlapping frame to
   * frame long before they stop being the same person.
   */
  readonly maxCenterDriftFraction?: number;
  /** Smaller-to-larger area ratio below which two boxes are not the same thing. */
  readonly minSizeRatio?: number;
  /** Fraction of sampled frames the primary must appear in to be trusted. */
  readonly minCoverage?: number;
  /** Absolute floor on observations, whatever the coverage works out to. */
  readonly minObservations?: number;
}

export const ASSOCIATE_DEFAULTS = {
  minConfidence: 0.5,
  maxGapSec: 1.5,
  matchIouThreshold: 0.2,
  maxCenterDriftFraction: 0.12,
  minSizeRatio: 0.25,
  minCoverage: 0.35,
  minObservations: 2,
} as const;

/**
 * The primary subject's observations, or nothing.
 *
 * Empty is a real answer and the common one for footage this cannot handle: no
 * detections at all, nothing above the confidence floor, or a best track too
 * intermittent to follow. Callers hand the result to `buildCropPath`, which
 * treats an empty list as "centre crop".
 */
export function trackPrimarySubject(
  frames: readonly DetectionFrame[],
  options: AssociateOptions,
): readonly SubjectObservation[] {
  const tracks = associateTracks(frames, options);
  const primary = selectPrimaryTrack(tracks);
  if (!primary) return [];

  const settings = { ...ASSOCIATE_DEFAULTS, ...definedOnly(options) };
  const sampled = frames.length;
  const coverage = sampled > 0 ? primary.observations.length / sampled : 0;

  if (primary.observations.length < settings.minObservations) return [];
  if (coverage < settings.minCoverage) return [];

  return primary.observations;
}

/**
 * Every subject the detections support, longest-lived first by score.
 *
 * Separate from `trackPrimarySubject` because the tracks are the interesting
 * intermediate: a future multi-speaker mode picks a different one of these per
 * sentence rather than one for the whole clip, and the tests assert on them
 * directly.
 */
export function associateTracks(
  frames: readonly DetectionFrame[],
  options: AssociateOptions,
): readonly SubjectTrack[] {
  const settings = { ...ASSOCIATE_DEFAULTS, ...definedOnly(options) };
  const { source } = options;
  const maxDrift = settings.maxCenterDriftFraction * source.width;
  const frameArea = source.width * source.height;

  interface OpenTrack {
    readonly subjectId: string;
    readonly observations: SubjectObservation[];
    lastSeenSec: number;
    lastBox: FrameDetection;
  }

  const tracks: OpenTrack[] = [];
  let nextId = 1;

  const ordered = [...frames].sort((a, b) => a.atSec - b.atSec);

  for (const frame of ordered) {
    if (!Number.isFinite(frame.atSec)) continue;

    const detections = frame.detections
      .filter((d) => usable(d) && d.confidence >= settings.minConfidence)
      // Strongest first only to make the greedy pass deterministic; the actual
      // assignment is by pair score, not by this order.
      .sort((a, b) => b.confidence - a.confidence || a.x - b.x || a.y - b.y);

    const open = tracks.filter((track) => frame.atSec - track.lastSeenSec <= settings.maxGapSec);

    // Score every plausible (track, detection) pair, then take them best-first.
    // Greedy on a fully scored set, rather than first-come, so a detection that
    // fits two tracks goes to the one it fits better.
    const pairs: { track: OpenTrack; detection: FrameDetection; score: number }[] = [];

    for (const track of open) {
      for (const detection of detections) {
        const overlap = iou(track.lastBox, detection);
        const drift = centreDistance(track.lastBox, detection);
        const ratio = areaRatio(track.lastBox, detection);

        if (ratio < settings.minSizeRatio) continue;
        if (overlap < settings.matchIouThreshold && drift > maxDrift) continue;

        pairs.push({
          track,
          detection,
          score: overlap + Math.max(0, 1 - drift / Math.max(1, maxDrift)),
        });
      }
    }

    pairs.sort((a, b) => b.score - a.score || a.detection.x - b.detection.x || a.detection.y - b.detection.y);

    const usedTracks = new Set<OpenTrack>();
    const usedDetections = new Set<FrameDetection>();

    for (const pair of pairs) {
      if (usedTracks.has(pair.track) || usedDetections.has(pair.detection)) continue;
      usedTracks.add(pair.track);
      usedDetections.add(pair.detection);

      pair.track.observations.push(toObservation(pair.detection, frame.atSec, pair.track.subjectId));
      pair.track.lastSeenSec = frame.atSec;
      pair.track.lastBox = pair.detection;
    }

    for (const detection of detections) {
      if (usedDetections.has(detection)) continue;

      const subjectId = `subject-${nextId}`;
      nextId += 1;
      tracks.push({
        subjectId,
        observations: [toObservation(detection, frame.atSec, subjectId)],
        lastSeenSec: frame.atSec,
        lastBox: detection,
      });
    }
  }

  return tracks
    .map((track) => ({
      subjectId: track.subjectId,
      observations: track.observations as readonly SubjectObservation[],
      score: presenceScore(track.observations, frameArea),
    }))
    .sort((a, b) => b.score - a.score || a.subjectId.localeCompare(b.subjectId));
}

/** The track worth following: most present, not merely most confident once. */
export function selectPrimaryTrack(tracks: readonly SubjectTrack[]): SubjectTrack | null {
  return tracks.reduce<SubjectTrack | null>((best, track) => {
    if (!best) return track;
    if (track.score > best.score) return track;
    if (track.score < best.score) return best;

    // Equal presence: prefer whoever was there first, then a stable identifier.
    const trackStart = track.observations[0]?.atSec ?? Infinity;
    const bestStart = best.observations[0]?.atSec ?? Infinity;
    if (trackStart !== bestStart) return trackStart < bestStart ? track : best;
    return track.subjectId.localeCompare(best.subjectId) < 0 ? track : best;
  }, null);
}

/* -------------------------------------------------------------------------- */

/**
 * Presence: confidence summed over time, weighted by apparent size.
 *
 * The square root is what stops a close-up from outweighing a subject who is
 * simply present throughout — area doubles fast, and the person the crop should
 * follow is usually the one on screen longest, not the one nearest the lens.
 */
const presenceScore = (observations: readonly SubjectObservation[], frameArea: number): number =>
  observations.reduce((total, o) => {
    const fraction = frameArea > 0 ? (o.width * o.height) / frameArea : 0;
    return total + o.confidence * Math.sqrt(Math.max(0, fraction));
  }, 0);

const toObservation = (
  detection: FrameDetection,
  atSec: number,
  subjectId: string,
): SubjectObservation => ({
  atSec,
  x: detection.x,
  y: detection.y,
  width: detection.width,
  height: detection.height,
  confidence: detection.confidence,
  subjectId,
});

const centreDistance = (a: FrameDetection, b: FrameDetection): number =>
  Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));

const areaRatio = (a: FrameDetection, b: FrameDetection): number => {
  const first = a.width * a.height;
  const second = b.width * b.height;
  if (!(first > 0) || !(second > 0)) return 0;
  return Math.min(first, second) / Math.max(first, second);
};

const usable = (detection: FrameDetection): boolean =>
  Number.isFinite(detection.x) &&
  Number.isFinite(detection.y) &&
  detection.width > 0 &&
  detection.height > 0 &&
  detection.confidence >= 0 &&
  detection.confidence <= 1;

const definedOnly = <T extends object>(source: T): Partial<T> =>
  Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as Partial<T>;
