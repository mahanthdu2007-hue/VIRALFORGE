/**
 * Transcript validation and normalisation.
 *
 * The transcript is the source of truth for every later phase, so a malformed
 * one must never reach the database. The split is deliberate:
 *
 *   normalise — formatting only. Trimming, unicode whitespace, ordering.
 *   reject    — anything that would make timings meaningless.
 *
 * Spoken words are never altered. Not corrected, not re-punctuated, not
 * re-cased. If text is unusable the segment is rejected, not rewritten.
 */

import { processingError } from '@/lib/errors';
import type { TranscriptionDraft, TranscriptSegmentDraft, TranscriptWordDraft } from '@/ai/types';

/** Timings may exceed the probed duration by this much before we reject. */
const DURATION_TOLERANCE_SEC = 1;

/** Adjacent segments may overlap by this much; ASR boundaries are fuzzy. */
const OVERLAP_TOLERANCE_SEC = 0.25;

export interface NormalisedWord {
  readonly text: string;
  readonly startSec: number;
  readonly endSec: number;
}

export interface NormalisedSegment {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  readonly confidence: number | null;
  readonly speaker: string | null;
  readonly words: readonly NormalisedWord[] | null;
}

export interface NormalisedTranscript {
  readonly language: string | null;
  readonly model: string;
  readonly segments: readonly NormalisedSegment[];
  /** Formatting-level fixes applied, for logging. Never includes word changes. */
  readonly notes: readonly string[];
}

/**
 * Validate and normalise a provider's transcription output.
 *
 * @param draft       raw provider output
 * @param durationSec probed media duration, the ceiling for every timestamp
 * @throws AppError kind=processing when the draft cannot be trusted
 */
export function normaliseTranscriptDraft(draft: TranscriptionDraft, durationSec: number): NormalisedTranscript {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw processingError('invalid_media_duration', 'Cannot validate a transcript without a media duration.', {
      details: { durationSec },
    });
  }

  const notes: string[] = [];
  const limit = durationSec + DURATION_TOLERANCE_SEC;
  const kept: NormalisedSegment[] = [];

  // Order first: a provider returning segments out of order is a formatting
  // problem, and sorting is safe because each segment carries its own timing.
  const ordered = [...draft.segments].sort((a, b) => a.startSec - b.startSec);
  if (ordered.some((segment, i) => segment !== draft.segments[i])) {
    notes.push('segments reordered by start time');
  }

  for (const [index, segment] of ordered.entries()) {
    assertFiniteRange(segment, index);

    if (segment.startSec > limit) {
      throw reject(index, `starts at ${segment.startSec}s, beyond the media duration of ${durationSec}s`);
    }

    const text = normaliseWhitespace(segment.text);
    if (text.length === 0) {
      // Silence between utterances is normal; an empty cue carries nothing.
      notes.push(`segment ${index} dropped: no text`);
      continue;
    }

    // Clamp only the tail: a provider overshooting the final timestamp by a
    // fraction of a second is a rounding artefact, not a broken transcript.
    let endSec = segment.endSec;
    if (endSec > durationSec) {
      if (endSec > limit) {
        throw reject(index, `ends at ${endSec}s, beyond the media duration of ${durationSec}s`);
      }
      endSec = durationSec;
      notes.push(`segment ${index} end clamped to media duration`);
    }

    const previous = kept.at(-1);
    if (previous && segment.startSec < previous.endSec - OVERLAP_TOLERANCE_SEC) {
      throw reject(
        index,
        `starts at ${segment.startSec}s, overlapping the previous segment which ends at ${previous.endSec}s`,
      );
    }

    kept.push({
      startSec: round3(segment.startSec),
      endSec: round3(endSec),
      text,
      confidence: normaliseConfidence(segment.confidence),
      speaker: segment.speaker?.trim() || null,
      words: normaliseWords(segment, endSec, index, notes),
    });
  }

  if (kept.length === 0) {
    throw processingError('empty_transcript', 'The transcript contains no usable speech.', {
      details: { segmentsReceived: draft.segments.length },
    });
  }

  return {
    language: draft.language?.trim() || null,
    model: draft.model,
    segments: kept,
    notes,
  };
}

/* -------------------------------------------------------------------------- */

function assertFiniteRange(segment: TranscriptSegmentDraft, index: number): void {
  if (!Number.isFinite(segment.startSec) || !Number.isFinite(segment.endSec)) {
    throw reject(index, 'has a non-numeric timestamp');
  }
  if (segment.startSec < 0) {
    throw reject(index, `has a negative start time (${segment.startSec}s)`);
  }
  if (segment.endSec <= segment.startSec) {
    throw reject(index, `ends at ${segment.endSec}s, at or before its start of ${segment.startSec}s`);
  }
}

/**
 * Word timings are advisory: a bad one costs subtitle precision, not
 * correctness, so unusable words are dropped rather than failing the transcript.
 */
function normaliseWords(
  segment: TranscriptSegmentDraft,
  endSec: number,
  index: number,
  notes: string[],
): readonly NormalisedWord[] | null {
  if (!segment.words || segment.words.length === 0) return null;

  const usable = segment.words
    .filter((word: TranscriptWordDraft) => {
      if (!Number.isFinite(word.startSec) || !Number.isFinite(word.endSec)) return false;
      if (word.startSec < 0 || word.endSec <= word.startSec) return false;
      if (word.endSec > endSec + DURATION_TOLERANCE_SEC) return false;
      return normaliseWhitespace(word.text).length > 0;
    })
    .map((word) => ({
      text: normaliseWhitespace(word.text),
      startSec: round3(word.startSec),
      endSec: round3(Math.min(word.endSec, endSec)),
    }))
    .sort((a, b) => a.startSec - b.startSec);

  if (usable.length !== segment.words.length) {
    notes.push(`segment ${index}: ${segment.words.length - usable.length} word timing(s) dropped`);
  }

  return usable.length > 0 ? usable : null;
}

/**
 * Whitespace only. Collapses unicode spaces and runs of blanks, trims the ends.
 * Letters, punctuation and casing are untouched — those are the speaker's.
 */
export const normaliseWhitespace = (text: string): string => text.replace(/\s+/gu, ' ').trim();

const normaliseConfidence = (value: number | undefined): number | null => {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const reject = (index: number, problem: string) =>
  processingError('invalid_transcript_segment', `Transcript segment ${index} ${problem}.`, {
    details: { segmentIndex: index, problem },
  });
