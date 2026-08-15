/**
 * Refinement validation.
 *
 * The model is allowed to *read* a clip; it is not allowed to change what the
 * clip says. Everything it returns passes through here first:
 *
 *  - numbers must be real 0..1 values, or the whole refinement is dropped;
 *  - the title is metadata, so it is sanitised (trimmed, bounded) rather than
 *    trusted or rejected outright;
 *  - `hookQuote` must occur verbatim in the clip's own transcript text. A quote
 *    that does not is treated as fabrication and the **entire refinement is
 *    discarded** — a provider that invented speech has not earned the benefit of
 *    the doubt on its ratings either.
 *
 * A rejected refinement is never an error: scoring has a full deterministic
 * path, so the run continues with the rules alone and the rejection is logged.
 */

import { isUnitScore, verifyQuote } from '@/domain';
import type { ClipRefinementDraft } from '@/ai/types';
import type { SemanticHints } from '@/clips/scoring';

export type RefinementRejectionCode =
  | 'malformed_response'
  | 'invalid_scores'
  | 'quote_not_verbatim'
  | 'title_unusable';

export interface RefinementRejection {
  readonly code: RefinementRejectionCode;
  readonly reason: string;
}

export interface ValidatedRefinement {
  /** Null when the model gave nothing usable; construction falls back. */
  readonly title: string | null;
  readonly hookQuote: string | null;
  readonly hints: SemanticHints;
}

export interface RefinementValidationResult {
  /** Null when nothing survived validation. */
  readonly refinement: ValidatedRefinement | null;
  readonly rejections: readonly RefinementRejection[];
}

/** Titles are UI metadata; anything longer is a paragraph, not a title. */
const MAX_TITLE_CHARS = 80;

/** Control characters, which have no place in a displayed title. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/gu;

/**
 * @param draft    unvalidated provider output
 * @param clipText verbatim transcript text of the clip the draft describes
 */
export function validateRefinement(draft: unknown, clipText: string): RefinementValidationResult {
  if (typeof draft !== 'object' || draft === null) {
    return reject('malformed_response', 'Refinement response was not an object.');
  }

  const value = draft as Partial<ClipRefinementDraft>;

  const hints = {
    curiosity: value.curiosity,
    standalone: value.standalone,
    payoff: value.payoff,
    contextDependency: value.contextDependency,
  };

  const bad = Object.entries(hints).find(([, score]) => !isUnitScore(score));
  if (bad) {
    return reject('invalid_scores', `Field "${bad[0]}" is not a number between 0 and 1.`);
  }

  // The hard boundary, the same guard the discovery phase uses.
  let hookQuote: string | null = null;
  const claimed = typeof value.hookQuote === 'string' ? value.hookQuote.trim() : '';
  if (claimed.length > 0) {
    const verification = verifyQuote(claimed, clipText);
    if (!verification.ok) {
      return reject('quote_not_verbatim', `hookQuote rejected: ${verification.reason}`);
    }
    hookQuote = claimed;
  }

  const rejections: RefinementRejection[] = [];
  const title = sanitiseTitle(value.title);
  if (title === null) {
    rejections.push({ code: 'title_unusable', reason: 'Title was empty or unusable after sanitising.' });
  }

  return {
    refinement: {
      title,
      hookQuote,
      hints: {
        curiosity: hints.curiosity as number,
        standalone: hints.standalone as number,
        payoff: hints.payoff as number,
        contextDependency: hints.contextDependency as number,
      } satisfies SemanticHints,
    },
    rejections,
  };
}

/**
 * Titles are the one field we accept in the model's own words, so they are
 * bounded and stripped of control characters rather than trusted as-is.
 */
export function sanitiseTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const cleaned = value.replace(CONTROL_CHARS, ' ').replace(/\s+/gu, ' ').trim();

  if (cleaned.length === 0) return null;
  return cleaned.length > MAX_TITLE_CHARS ? `${cleaned.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : cleaned;
}

const reject = (code: RefinementRejectionCode, reason: string): RefinementValidationResult => ({
  refinement: null,
  rejections: [{ code, reason }],
});
