/**
 * Candidate validation.
 *
 * Discovery output is model-generated, so every field is checked before it can
 * become a `CandidateClip`. A candidate that fails is **rejected with a reason**,
 * never repaired: inventing a replacement quote or nudging a bad boundary would
 * be exactly the kind of quiet fabrication this project promises not to do.
 *
 * One invalid candidate does not fail the run — the rest are kept and the
 * rejections are returned for logging.
 */

import {
  CANDIDATE_MAX_DURATION_SEC,
  CANDIDATE_MIN_DURATION_SEC,
  isUnitScore,
  textInRange,
  verifyQuote,
  type ClipSignals,
  type Transcript,
  type TranscriptSegment,
} from '@/domain';
import type { CandidateClipDraft } from '@/ai/types';

export type CandidateRejectionCode =
  | 'invalid_range'
  | 'outside_media'
  | 'too_short'
  | 'too_long'
  | 'no_transcript_text'
  | 'missing_reason'
  | 'invalid_signals'
  | 'invalid_confidence'
  | 'quote_not_verbatim';

export interface AcceptedCandidate {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  readonly segmentIds: readonly TranscriptSegment['id'][];
  readonly hookQuote: string | null;
  readonly topic: string | null;
  readonly reason: string;
  readonly signals: ClipSignals;
  readonly confidence: number | null;
}

export interface RejectedCandidate {
  readonly code: CandidateRejectionCode;
  readonly reason: string;
  /** Enough to identify the offending draft in a log, without dumping it whole. */
  readonly range: { startSec: number; endSec: number };
}

export interface CandidateValidationResult {
  readonly accepted: readonly AcceptedCandidate[];
  readonly rejected: readonly RejectedCandidate[];
}

export interface CandidateValidationOptions {
  readonly minDurationSec?: number;
  readonly maxDurationSec?: number;
  /** Tolerance for a boundary that runs marginally past the media end. */
  readonly durationToleranceSec?: number;
}

/**
 * Validate discovery drafts against the transcript they claim to come from.
 *
 * @param drafts     raw provider output
 * @param transcript the persisted, already-validated transcript
 * @param mediaDurationSec probed duration of the source video
 */
export function validateCandidates(
  drafts: readonly CandidateClipDraft[],
  transcript: Transcript,
  mediaDurationSec: number,
  options: CandidateValidationOptions = {},
): CandidateValidationResult {
  const minDuration = options.minDurationSec ?? CANDIDATE_MIN_DURATION_SEC;
  const maxDuration = options.maxDurationSec ?? CANDIDATE_MAX_DURATION_SEC;
  const tolerance = options.durationToleranceSec ?? 1;

  const accepted: AcceptedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const draft of drafts) {
    const range = { startSec: draft.startSec, endSec: draft.endSec };
    const fail = (code: CandidateRejectionCode, reason: string) => rejected.push({ code, reason, range });

    if (
      !Number.isFinite(draft.startSec) ||
      !Number.isFinite(draft.endSec) ||
      draft.startSec < 0 ||
      draft.endSec <= draft.startSec
    ) {
      fail('invalid_range', 'Start and end are not a valid forward time range.');
      continue;
    }

    if (draft.startSec >= mediaDurationSec || draft.endSec > mediaDurationSec + tolerance) {
      fail('outside_media', `Range falls outside the media duration of ${mediaDurationSec}s.`);
      continue;
    }

    // Clamping the tail is a rounding fix, not a content change.
    const endSec = Math.min(draft.endSec, mediaDurationSec);
    const duration = endSec - draft.startSec;

    if (duration < minDuration) {
      fail('too_short', `Moment is ${duration.toFixed(1)}s, below the ${minDuration}s minimum.`);
      continue;
    }
    if (duration > maxDuration) {
      fail('too_long', `Moment is ${duration.toFixed(1)}s, above the ${maxDuration}s maximum.`);
      continue;
    }

    const covered = transcript.segments.filter((s) => s.startSec < endSec && s.endSec > draft.startSec);
    const text = textInRange(transcript, { startSec: draft.startSec, endSec });
    if (covered.length === 0 || text.length === 0) {
      fail('no_transcript_text', 'No transcript speech falls inside the moment.');
      continue;
    }

    const reason = draft.reason?.trim() ?? '';
    if (reason.length === 0) {
      fail('missing_reason', 'Candidate has no stated reason.');
      continue;
    }

    if (!areSignalsValid(draft.signals)) {
      fail('invalid_signals', 'Signal values are missing or outside the 0..1 range.');
      continue;
    }

    if (draft.confidence !== undefined && !isUnitScore(draft.confidence)) {
      fail('invalid_confidence', 'Confidence is not a number between 0 and 1.');
      continue;
    }

    // The hard boundary. A quote that is not traceable to the transcript means
    // the model wrote words the speaker did not say.
    let hookQuote: string | null = null;
    if (draft.hookQuote !== null && draft.hookQuote.trim() !== '') {
      const verification = verifyQuote(draft.hookQuote, text);
      if (!verification.ok) {
        fail('quote_not_verbatim', `hookQuote rejected: ${verification.reason}`);
        continue;
      }
      hookQuote = draft.hookQuote.trim();
    }

    accepted.push({
      startSec: round3(draft.startSec),
      endSec: round3(endSec),
      text,
      segmentIds: covered.map((s) => s.id),
      hookQuote,
      topic: draft.topic?.trim() || null,
      reason,
      signals: draft.signals,
      confidence: draft.confidence ?? null,
    });
  }

  return { accepted, rejected };
}

/** Every signal must be present, and every numeric one inside 0..1. */
function areSignalsValid(signals: ClipSignals | undefined): signals is ClipSignals {
  if (!signals || typeof signals !== 'object') return false;

  const flags = [
    signals.strongOpening,
    signals.questionAnswered,
    signals.strongOpinion,
    signals.surprise,
    signals.story,
    signals.payoff,
  ];
  if (flags.some((flag) => typeof flag !== 'boolean')) return false;

  const scores = [signals.emotionalIntensity, signals.informationDensity, signals.standalone];
  return scores.every(isUnitScore);
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
