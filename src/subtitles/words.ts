/**
 * Transcript → timed words on the clip timeline.
 *
 * The subtitle engine never reads `TranscriptSegment.text` and word timings as
 * two independent sources of truth. Exactly one of them is used per segment:
 *
 *  - **Word timings present.** Each word is taken as the provider reported it,
 *    text and interval together, and mapped onto the clip. Nothing is
 *    interpolated.
 *  - **Word timings absent.** The segment's own text is split on whitespace and
 *    the segment's own span is apportioned across those tokens in proportion to
 *    their length. This estimates *timing* — never text — and every word it
 *    produces is marked `timingSource: 'segment'` so the estimate is visible
 *    downstream rather than indistinguishable from a measurement.
 *
 * Splitting on whitespace is what keeps the second path honest: the tokens are
 * substrings of the transcript, so joining them with single spaces reproduces
 * the segment's speech exactly, punctuation included.
 */

import type { SubtitleSourceWord, TranscriptSegment, TranscriptWord } from '@/domain';
import { mapRangeToClip, type ClipTimeline } from './timeline';

export interface CollectedWords {
  readonly words: readonly SubtitleSourceWord[];
  /** Machine-readable notes, e.g. `segment_timing_estimated`. */
  readonly notes: readonly string[];
}

/**
 * Every transcript word the clip actually plays, on the clip timeline, in order.
 *
 * Words the cuts do not carry are dropped; words straddling a boundary are
 * clipped to what survives. The result is sorted by start time, which a
 * multi-cut plan needs — the transcript is in source order, and cuts may be
 * taken out of source order.
 */
export function collectClipWords(
  segments: readonly TranscriptSegment[],
  timeline: ClipTimeline,
): CollectedWords {
  const words: SubtitleSourceWord[] = [];
  const notes = new Set<string>();

  let sawWordTimings = false;
  let sawSegmentFallback = false;

  for (const segment of segments) {
    // Cheap rejection: a segment no cut touches cannot contribute a word.
    if (mapRangeToClip(timeline, segment) === null) continue;

    const timed = segment.words ?? [];
    const usable = timed.filter(isUsableWord);

    if (usable.length > 0) {
      sawWordTimings = true;
      if (usable.length !== timed.length) notes.add('words_with_unusable_timing_dropped');

      for (const word of usable) {
        const mapped = mapRangeToClip(timeline, word);
        if (!mapped) continue;
        words.push({
          ...mapped,
          text: word.text.trim(),
          sourceSegmentId: segment.id,
          timingSource: 'word',
        });
      }
      continue;
    }

    const apportioned = apportionSegment(segment);
    if (apportioned.length === 0) continue;

    sawSegmentFallback = true;
    for (const word of apportioned) {
      const mapped = mapRangeToClip(timeline, word);
      if (!mapped) continue;
      words.push({
        ...mapped,
        text: word.text,
        sourceSegmentId: segment.id,
        timingSource: 'segment',
      });
    }
  }

  if (sawSegmentFallback) notes.add('segment_timing_estimated');
  if (!sawWordTimings && sawSegmentFallback) notes.add('no_word_timings');
  if (words.length === 0) notes.add('no_speech_in_clip');

  return {
    words: words
      .filter((word) => word.text.length > 0)
      .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec),
    notes: [...notes],
  };
}

/**
 * Split a segment's verbatim text across its own span.
 *
 * Weighted by token length rather than evenly: "extraordinarily" takes longer
 * to say than "a", and a uniform split would leave short words lingering while
 * long ones flash past. Both are estimates; this one is less wrong.
 */
export function apportionSegment(
  segment: Pick<TranscriptSegment, 'text' | 'startSec' | 'endSec'>,
): readonly { readonly text: string; readonly startSec: number; readonly endSec: number }[] {
  const tokens = segment.text.trim().split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) return [];

  const durationSec = segment.endSec - segment.startSec;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];

  // +1 per token so a one-character word still gets a share, and so the weights
  // can never sum to zero.
  const weights = tokens.map((token) => token.length + 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  let cursor = segment.startSec;

  return tokens.map((text, index) => {
    const startSec = cursor;
    // The last token ends exactly on the segment's end, so accumulated rounding
    // cannot push the final word past the speech it belongs to.
    const endSec =
      index === tokens.length - 1 ? segment.endSec : startSec + (durationSec * weights[index]!) / total;
    cursor = endSec;
    return { text, startSec, endSec };
  });
}

const isUsableWord = (word: TranscriptWord): boolean =>
  typeof word.text === 'string' &&
  word.text.trim().length > 0 &&
  Number.isFinite(word.startSec) &&
  Number.isFinite(word.endSec) &&
  word.endSec > word.startSec &&
  word.startSec >= 0;
