/**
 * Boundary snapping.
 *
 * A Short that begins mid-word or ends mid-sentence reads as broken however
 * good the moment is, so the boundaries a candidate arrives with are treated as
 * *approximate* and moved to the nearest defensible anchor.
 *
 * Anchors come from the transcript itself: word timings when the provider
 * supplied them, segment timings when it did not. Nothing here invents a
 * timestamp — a boundary is always some timing the transcript already contains,
 * or, failing that, exactly where the candidate put it.
 *
 * Pure and synchronous: no AI, no I/O. Boundary choice is safety-critical for
 * the verbatim guarantee, so it is a deterministic rule.
 */

import type { BoundarySnap, Transcript, TranscriptSegment } from '@/domain';
import { endsSentence } from './text';

/**
 * One indivisible unit of speech on the timeline — a word, or a whole segment
 * when word timings are absent. Uniform so the search below does not care which
 * granularity it got.
 */
export interface SpeechToken {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  readonly source: 'word' | 'segment';
  /** The segment this token belongs to. */
  readonly segmentIndex: number;
}

/**
 * Flatten a transcript into ordered tokens.
 *
 * Word timings are preferred and used per segment: a transcript where only some
 * segments carry words still gets word precision where it can.
 */
export function toSpeechTokens(segments: readonly TranscriptSegment[]): SpeechToken[] {
  const tokens: SpeechToken[] = [];

  segments.forEach((segment, segmentIndex) => {
    const words = segment.words;
    if (words && words.length > 0) {
      for (const word of words) {
        // A word whose timing falls outside its segment is provider noise; the
        // segment bounds are the trustworthy figure.
        const startSec = clamp(word.startSec, segment.startSec, segment.endSec);
        const endSec = clamp(word.endSec, startSec, segment.endSec);
        if (endSec > startSec && word.text.trim().length > 0) {
          tokens.push({ startSec, endSec, text: word.text.trim(), source: 'word', segmentIndex });
        }
      }
      // A segment whose words were all unusable still contributes its own span.
      if (tokens.at(-1)?.segmentIndex === segmentIndex) return;
    }

    tokens.push({
      startSec: segment.startSec,
      endSec: segment.endSec,
      text: segment.text.trim(),
      source: 'segment',
      segmentIndex,
    });
  });

  return tokens.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

/** A timestamp a boundary may legally land on. */
export interface BoundaryAnchor {
  readonly atSec: number;
  readonly snap: BoundarySnap;
  /** Begins (for starts) or completes (for ends) a sentence. */
  readonly sentence: boolean;
}

/**
 * Candidate start positions: the leading edge of every token.
 *
 * A start is a sentence start when the previous token finished one — or when
 * there is no previous token, since the transcript itself begins there.
 */
export function startAnchors(tokens: readonly SpeechToken[]): BoundaryAnchor[] {
  return tokens.map((token, index) => ({
    atSec: token.startSec,
    snap: token.source,
    sentence: index === 0 || endsSentence(tokens[index - 1]!.text),
  }));
}

/** Candidate end positions: the trailing edge of every token. */
export function endAnchors(tokens: readonly SpeechToken[]): BoundaryAnchor[] {
  return tokens.map((token) => ({
    atSec: token.endSec,
    snap: token.source,
    sentence: endsSentence(token.text),
  }));
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

export interface BoundaryPolicy {
  /** Preferred runtime window. */
  readonly targetMinSec: number;
  readonly targetMaxSec: number;
  /** Absolute limits; a clip outside these is refused, never truncated. */
  readonly hardMinSec: number;
  readonly hardMaxSec: number;
  /** How far the start may move earlier / later than the candidate's. */
  readonly startBackSec: number;
  readonly startForwardSec: number;
  /**
   * Cost, in seconds-equivalent, of a boundary that cuts a sentence. Large:
   * preserving a complete thought is worth several seconds of duration drift.
   */
  readonly incompleteSentenceCost: number;
}

export const DEFAULT_BOUNDARY_POLICY: BoundaryPolicy = {
  targetMinSec: 30,
  targetMaxSec: 40,
  hardMinSec: 15,
  hardMaxSec: 55,
  startBackSec: 6,
  startForwardSec: 8,
  incompleteSentenceCost: 25,
};

export interface ChosenBoundaries {
  readonly startSec: number;
  readonly endSec: number;
  readonly startSnap: BoundarySnap;
  readonly endSnap: BoundarySnap;
  readonly startsOnSentence: boolean;
  readonly endsOnSentence: boolean;
  readonly notes: readonly string[];
}

/**
 * Choose the boundaries for one clip.
 *
 * Start first, because the end is only meaningful relative to it: the search
 * then picks the end that best trades runtime against finishing a thought.
 *
 * @param tokens  every token in the transcript, ordered
 * @param range   the candidate's approximate boundaries
 * @param mediaDurationSec probed duration, never exceeded
 */
export function chooseBoundaries(
  tokens: readonly SpeechToken[],
  range: { startSec: number; endSec: number },
  mediaDurationSec: number,
  policy: BoundaryPolicy = DEFAULT_BOUNDARY_POLICY,
): ChosenBoundaries {
  const notes: string[] = [];

  if (tokens.length === 0) {
    return {
      startSec: range.startSec,
      endSec: Math.min(range.endSec, mediaDurationSec),
      startSnap: 'candidate',
      endSnap: 'candidate',
      startsOnSentence: false,
      endsOnSentence: false,
      notes: ['no_speech_tokens'],
    };
  }

  const starts = startAnchors(tokens);
  const ends = endAnchors(tokens);

  /* -- Start ------------------------------------------------------------- */
  const startWindow = starts.filter(
    (anchor) =>
      anchor.atSec >= range.startSec - policy.startBackSec &&
      anchor.atSec <= range.startSec + policy.startForwardSec,
  );

  const start = best(startWindow, (anchor) => {
    const drift = Math.abs(anchor.atSec - range.startSec);
    return drift + (anchor.sentence ? 0 : policy.incompleteSentenceCost);
  });

  const startSec = start?.atSec ?? range.startSec;
  if (!start) notes.push('no_start_anchor_in_window');
  else if (!start.sentence) notes.push('start_not_on_sentence');

  /* -- End --------------------------------------------------------------- */
  const endWindow = ends.filter((anchor) => {
    const duration = anchor.atSec - startSec;
    return duration >= policy.hardMinSec && duration <= policy.hardMaxSec;
  });

  const end = best(endWindow, (anchor) => {
    const duration = anchor.atSec - startSec;
    // Distance outside the target window, in seconds. Zero inside it, so any
    // complete-sentence end in 30–40s beats one outside regardless of drift.
    const miss =
      duration < policy.targetMinSec
        ? policy.targetMinSec - duration
        : duration > policy.targetMaxSec
          ? duration - policy.targetMaxSec
          : 0;
    // Tiny tie-break towards the candidate's own end, so an otherwise equal
    // choice stays closest to what discovery actually pointed at.
    const drift = Math.abs(anchor.atSec - range.endSec) * 0.02;
    return miss + drift + (anchor.sentence ? 0 : policy.incompleteSentenceCost);
  });

  if (!end) notes.push('no_end_anchor_in_window');
  else if (!end.sentence) notes.push('end_not_on_sentence');

  const rawEnd = end?.atSec ?? range.endSec;
  const endSec = Math.min(rawEnd, mediaDurationSec);
  if (endSec < rawEnd) notes.push('end_clamped_to_media');

  return {
    startSec: round3(startSec),
    endSec: round3(endSec),
    startSnap: start?.snap ?? 'candidate',
    endSnap: endSec < rawEnd ? 'media' : (end?.snap ?? 'candidate'),
    startsOnSentence: start?.sentence ?? false,
    endsOnSentence: (end?.sentence ?? false) && endSec === rawEnd,
    notes,
  };
}

/** Lowest cost wins; ties go to the earlier anchor, so the result is stable. */
function best(anchors: readonly BoundaryAnchor[], cost: (anchor: BoundaryAnchor) => number) {
  let winner: BoundaryAnchor | null = null;
  let winningCost = Infinity;

  for (const anchor of anchors) {
    const value = cost(anchor);
    if (value < winningCost) {
      winner = anchor;
      winningCost = value;
    }
  }

  return winner;
}

/** Segments the chosen range covers, in transcript order. */
export const segmentsInRange = (
  transcript: Transcript,
  range: { startSec: number; endSec: number },
): readonly TranscriptSegment[] =>
  transcript.segments.filter((s) => s.startSec < range.endSec && s.endSec > range.startSec);

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
const round3 = (value: number): number => Math.round(value * 1000) / 1000;
