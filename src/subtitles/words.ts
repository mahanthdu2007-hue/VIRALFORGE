/**
 * Transcript → timed words on the clip timeline.
 *
 * The subtitle engine never reads `TranscriptSegment.text` and word timings as
 * two independent sources of truth. Exactly one of them is used per segment:
 *
 *  - **Word timings present *and complete*.** Each word is taken as the provider
 *    reported it, text and interval together, and mapped onto the clip. Nothing
 *    is interpolated.
 *  - **Word timings absent, or incomplete.** The segment's own text is split on
 *    whitespace and the segment's own span is apportioned across those tokens in
 *    proportion to their length. This estimates *timing* — never text — and
 *    every word it produces is marked `timingSource: 'segment'` so the estimate
 *    is visible downstream rather than indistinguishable from a measurement.
 *
 * Splitting on whitespace is what keeps the second path honest: the tokens are
 * substrings of the transcript, so joining them with single spaces reproduces
 * the segment's speech exactly, punctuation included.
 *
 * "Complete" is load-bearing and was learned the hard way. A provider may return
 * a word list that is a *subset* of what it transcribed: NVIDIA Parakeet timed
 * 2,139 of 5,662 words on a real 32-minute source, silently omitting the words
 * it could not align — mostly short function words. Taking that list at face
 * value builds cues that read "She looks she's struggling" where the speaker
 * said "She looks like she's struggling", which `verifySubtitleFidelity` then
 * correctly refuses to burn, and the clip ships with **no captions at all**.
 * A partial word list is therefore treated as no word list: better an
 * apportioned timing for the speaker's real sentence than an exact timing for a
 * sentence they did not say.
 */

import { normaliseForComparison, type SubtitleSourceWord, type TranscriptSegment, type TranscriptWord } from '@/domain';
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

    // A word list that does not spell the segment's own text is not a timing for
    // that text, whatever its length. Checked against the same normalisation the
    // verbatim guard uses, so "usable here" means exactly "burnable there".
    const complete = usable.length > 0 && wordsSpellSegmentText(usable, segment.text);
    if (usable.length > 0 && !complete) notes.add('word_timings_incomplete');

    if (complete) {
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

    // Partial timings are still evidence: the words the provider *did* time keep
    // their measured interval and only the gaps between them are estimated.
    const aligned = usable.length > 0 ? alignSegmentWords(segment, usable) : apportionSegment(segment);
    if (aligned.length === 0) continue;

    for (const word of aligned) {
      const mapped = mapRangeToClip(timeline, word);
      if (!mapped) continue;

      const measured = 'measured' in word && word.measured === true;
      if (measured) sawWordTimings = true;
      else sawSegmentFallback = true;

      words.push({
        ...mapped,
        text: word.text,
        sourceSegmentId: segment.id,
        timingSource: measured ? 'word' : 'segment',
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

/** A token with a span, and whether that span was measured or estimated. */
export interface AlignedWord {
  readonly text: string;
  readonly startSec: number;
  readonly endSec: number;
  /** True when the provider timed this exact word; false when interpolated. */
  readonly measured: boolean;
}

/**
 * The segment's own text, timed by whatever the provider managed to align.
 *
 * The middle ground between trusting a partial word list (which loses the words
 * it omits) and ignoring it (which throws away real measurements): every token
 * of the segment's text is kept, in order; tokens the provider timed keep that
 * exact interval; runs it skipped are spread across the gap their neighbours
 * leave, weighted by length the same way `apportionSegment` does.
 *
 * Why it matters: NVIDIA Parakeet times roughly a third of its own words, and
 * its segments run ~15s. Apportioning the whole span linearly ignores every
 * pause in it and drifts captions off the speech; anchoring to the words that
 * *were* measured pins the estimate back to reality several times a sentence.
 *
 * Matching is on alphanumerics alone, so a provider's punctuation or spacing
 * around a word cannot break the alignment — a token that still fails to match
 * is simply treated as one of the gaps.
 */
export function alignSegmentWords(
  segment: Pick<TranscriptSegment, 'text' | 'startSec' | 'endSec'>,
  timed: readonly TranscriptWord[],
): readonly AlignedWord[] {
  const tokens = segment.text.trim().split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) return [];

  // Walk both sequences forward together. Order is the only alignment signal
  // that is safe here: matching by text alone would let a repeated word ("like")
  // bind to the wrong occurrence and drag the timeline backwards.
  const anchors = new Map<number, TranscriptWord>();
  let next = 0;

  for (const word of timed) {
    const key = alignmentKey(word.text);
    if (key.length === 0) continue;

    for (let i = next; i < tokens.length; i += 1) {
      if (alignmentKey(tokens[i]!) !== key) continue;
      anchors.set(i, word);
      next = i + 1;
      break;
    }
  }

  if (anchors.size === 0) return apportionSegment(segment).map(toEstimated);

  const aligned: AlignedWord[] = [];
  let cursor = Math.min(segment.startSec, anchors.get([...anchors.keys()][0]!)!.startSec);

  for (let i = 0; i < tokens.length; ) {
    const anchor = anchors.get(i);
    if (anchor) {
      aligned.push({ text: tokens[i]!, startSec: anchor.startSec, endSec: anchor.endSec, measured: true });
      cursor = anchor.endSec;
      i += 1;
      continue;
    }

    // A run of untimed tokens, bounded by the previous anchor's end and the next
    // anchor's start — or by the segment's own edges at either extreme.
    let end = i;
    while (end < tokens.length && !anchors.has(end)) end += 1;

    const until = end < tokens.length ? anchors.get(end)!.startSec : Math.max(segment.endSec, cursor);
    const run = tokens.slice(i, end);
    for (const word of spread(run, cursor, until)) aligned.push(word);

    cursor = until;
    i = end;
  }

  return aligned;
}

/** Distribute tokens across `[from, to)`, weighted by length like apportioning. */
function spread(tokens: readonly string[], from: number, to: number): AlignedWord[] {
  const span = to - from;
  // A gap with no room (anchors back to back) still has to produce forward
  // ranges, so the words share a hairline rather than collapsing onto a point.
  const usable = Number.isFinite(span) && span > 0 ? span : tokens.length * MIN_ESTIMATED_SPAN_SEC;
  const weights = tokens.map((token) => token.length + 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  let cursor = from;
  return tokens.map((text, index) => {
    const startSec = cursor;
    const endSec = index === tokens.length - 1 ? from + usable : startSec + (usable * weights[index]!) / total;
    cursor = endSec;
    return { text, startSec, endSec, measured: false };
  });
}

/** Smallest span an estimated word may occupy when anchors leave no room. */
const MIN_ESTIMATED_SPAN_SEC = 0.02;

const toEstimated = (word: { text: string; startSec: number; endSec: number }): AlignedWord => ({
  ...word,
  measured: false,
});

/** Alphanumerics only: punctuation and case never decide an alignment. */
const alignmentKey = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Do these words, joined in order, say what the segment says?
 *
 * Compared through `normaliseForComparison` — the verbatim guard's own key — so
 * a provider's spacing or punctuation around a word cannot fail an otherwise
 * complete list, while a *missing* word always does.
 */
export function wordsSpellSegmentText(
  words: readonly TranscriptWord[],
  text: string,
): boolean {
  return normaliseForComparison(words.map((word) => word.text).join(' ')) === normaliseForComparison(text);
}

const isUsableWord = (word: TranscriptWord): boolean =>
  typeof word.text === 'string' &&
  word.text.trim().length > 0 &&
  Number.isFinite(word.startSec) &&
  Number.isFinite(word.endSec) &&
  word.endSec > word.startSec &&
  word.startSec >= 0;
