/**
 * Source timeline → clip timeline.
 *
 * A `ClipPlan` is a list of cuts taken from the source, played back-to-back. A
 * transcript word is timed against the *source*; a subtitle cue must be timed
 * against the *clip*, where zero is the first frame of the Short. This module is
 * that conversion and nothing else.
 *
 * Two behaviours are decisions rather than details:
 *
 *  1. **Words outside the cuts are dropped, not shifted.** Speech that was cut
 *     out was cut out; showing it because it sits near a boundary would caption
 *     words the viewer never hears.
 *  2. **A word straddling a boundary is clipped, not stretched.** Its text is
 *     untouched — only the interval is trimmed to the part that survives the
 *     cut. A word overlapping two cuts is assigned to the cut it spends most of
 *     itself in, which keeps it contiguous instead of splitting one utterance
 *     into two cues at a join the viewer hears as a jump.
 *
 * Pure: numbers in, numbers out.
 */

import type { ClipCut, TimeRange } from '@/domain';

/** The clip's cuts in playback order, with the offset each starts at. */
export interface ClipTimeline {
  readonly cuts: readonly ClipCut[];
  /** Clip-timeline offset of each cut, parallel to `cuts`. */
  readonly offsets: readonly number[];
  readonly durationSec: number;
}

/**
 * Order the cuts and precompute where each lands on the clip timeline.
 *
 * Cuts are sorted by `order` and then by start, so a caller that numbered them
 * inconsistently still gets a monotonic timeline rather than a silent scramble.
 * Cuts that are not forward ranges are dropped: they contribute no playback
 * time and would otherwise put a negative offset into every later cut.
 */
export function buildClipTimeline(cuts: readonly ClipCut[]): ClipTimeline {
  const usable = cuts
    .filter(
      (cut) =>
        Number.isFinite(cut.startSec) &&
        Number.isFinite(cut.endSec) &&
        cut.endSec > cut.startSec &&
        cut.startSec >= 0,
    )
    .sort((a, b) => a.order - b.order || a.startSec - b.startSec);

  const offsets: number[] = [];
  let elapsed = 0;

  for (const cut of usable) {
    offsets.push(elapsed);
    elapsed += cut.endSec - cut.startSec;
  }

  return { cuts: usable, offsets, durationSec: elapsed };
}

/**
 * A source-timeline range mapped onto the clip, or null when the cuts do not
 * carry it.
 *
 * The returned range is always inside `[0, durationSec]` and always forward:
 * a range that survives only as a zero-length sliver at a cut boundary is
 * reported as absent rather than as an instantaneous cue.
 */
export function mapRangeToClip(timeline: ClipTimeline, range: TimeRange): TimeRange | null {
  if (!Number.isFinite(range.startSec) || !Number.isFinite(range.endSec)) return null;
  if (range.endSec <= range.startSec) return null;

  let bestOverlap = 0;
  let mapped: TimeRange | null = null;

  for (const [index, cut] of timeline.cuts.entries()) {
    const startSec = Math.max(range.startSec, cut.startSec);
    const endSec = Math.min(range.endSec, cut.endSec);
    const overlap = endSec - startSec;
    if (overlap <= 0 || overlap <= bestOverlap) continue;

    const offset = timeline.offsets[index]!;
    bestOverlap = overlap;
    mapped = {
      startSec: offset + (startSec - cut.startSec),
      endSec: offset + (endSec - cut.startSec),
    };
  }

  return mapped;
}

/** Whether any cut carries the given source range at all. */
export const rangeSurvivesCuts = (timeline: ClipTimeline, range: TimeRange): boolean =>
  mapRangeToClip(timeline, range) !== null;
