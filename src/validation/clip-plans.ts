/**
 * Clip plan validation.
 *
 * Construction is deterministic, so most of this is a guard against our own
 * mistakes rather than against a model — but the verbatim check is not: the
 * hook quote may have come from a provider, and a plan carrying a line the
 * speaker never said must never reach the renderer.
 *
 * As with candidates, an invalid plan is **rejected with a reason**, never
 * repaired, and one bad plan does not fail the run.
 */

import {
  clipPlanDuration,
  isWithinClipHardLimits,
  verifyQuote,
  CLIP_HARD_MAX_DURATION_SEC,
  CLIP_HARD_MIN_DURATION_SEC,
} from '@/domain';
import type { ClipPlanDraft } from '@/clips/construction';

export type ClipPlanRejectionCode =
  | 'invalid_range'
  | 'outside_media'
  | 'too_short'
  | 'too_long'
  | 'no_cuts'
  | 'cuts_disordered'
  | 'duration_mismatch'
  | 'no_transcript_text'
  | 'quote_not_verbatim';

export interface RejectedClipPlan {
  readonly code: ClipPlanRejectionCode;
  readonly reason: string;
  readonly candidateClipId: string;
  readonly range: { startSec: number; endSec: number };
}

export interface ClipPlanValidationResult {
  readonly accepted: readonly ClipPlanDraft[];
  readonly rejected: readonly RejectedClipPlan[];
}

/** Tolerance for float drift when comparing a stored duration to its cuts. */
const DURATION_EPSILON = 0.01;

export function validateClipPlans(
  drafts: readonly ClipPlanDraft[],
  mediaDurationSec: number,
): ClipPlanValidationResult {
  const accepted: ClipPlanDraft[] = [];
  const rejected: RejectedClipPlan[] = [];

  for (const draft of drafts) {
    const range = { startSec: draft.startSec, endSec: draft.endSec };
    const fail = (code: ClipPlanRejectionCode, reason: string) =>
      rejected.push({ code, reason, candidateClipId: draft.candidateClipId, range });

    if (draft.cuts.length === 0) {
      fail('no_cuts', 'Plan has no cuts.');
      continue;
    }

    if (!areCutsOrdered(draft)) {
      fail('cuts_disordered', 'Cuts are not ordered, or a cut is not a forward range.');
      continue;
    }

    if (
      !Number.isFinite(draft.startSec) ||
      !Number.isFinite(draft.endSec) ||
      draft.startSec < 0 ||
      draft.endSec <= draft.startSec
    ) {
      fail('invalid_range', 'Start and end are not a valid forward time range.');
      continue;
    }

    if (draft.endSec > mediaDurationSec + DURATION_EPSILON) {
      fail('outside_media', `Plan ends past the media duration of ${mediaDurationSec}s.`);
      continue;
    }

    const cutDuration = clipPlanDuration(draft);
    if (Math.abs(cutDuration - draft.durationSec) > DURATION_EPSILON) {
      fail('duration_mismatch', 'Stated duration does not match the sum of the cuts.');
      continue;
    }

    if (!isWithinClipHardLimits(cutDuration)) {
      const tooShort = cutDuration < CLIP_HARD_MIN_DURATION_SEC;
      fail(
        tooShort ? 'too_short' : 'too_long',
        `Clip is ${cutDuration.toFixed(1)}s, outside the ${CLIP_HARD_MIN_DURATION_SEC}–${CLIP_HARD_MAX_DURATION_SEC}s limits.`,
      );
      continue;
    }

    if (draft.text.trim().length === 0 || draft.segmentIds.length === 0) {
      fail('no_transcript_text', 'Plan covers no transcript speech.');
      continue;
    }

    // The hard boundary: anything the plan carries as speech must be speech.
    if (draft.hookQuote !== null) {
      const verification = verifyQuote(draft.hookQuote, draft.text);
      if (!verification.ok) {
        fail('quote_not_verbatim', `hookQuote rejected: ${verification.reason}`);
        continue;
      }
    }

    accepted.push(draft);
  }

  return { accepted, rejected };
}

/** Cuts must ascend, each be a forward range, and not overlap each other. */
function areCutsOrdered(draft: ClipPlanDraft): boolean {
  let previousEnd = -Infinity;
  let previousOrder = -Infinity;

  for (const cut of draft.cuts) {
    if (!Number.isFinite(cut.startSec) || !Number.isFinite(cut.endSec)) return false;
    if (cut.endSec <= cut.startSec) return false;
    if (cut.order <= previousOrder && previousOrder !== -Infinity) return false;
    if (cut.startSec < previousEnd) return false;
    previousEnd = cut.endSec;
    previousOrder = cut.order;
  }

  return true;
}
