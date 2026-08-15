/**
 * Ranking and selection.
 *
 * Sorting by score is the easy half. The half that matters is *distinctness*:
 * discovery frequently finds the same strong moment three times with slightly
 * different edges, and three Shorts of the same forty seconds is a worse result
 * than one strong clip and two merely good ones.
 *
 * Two clips are the same moment when most of the shorter one is literally the
 * same seconds, or when they say materially the same thing. The first is
 * measured in seconds, the second by content-word overlap. Those are rejected
 * outright, whatever they score.
 *
 * Below that bar, resemblance is a matter of degree rather than a yes or no,
 * and it comes in two flavours. Two clips can *share seconds* without being the
 * same moment — a conversation moves on and the sentence that bridges two
 * subjects belongs to both — and two clips can share nothing at all yet still
 * be a thin pair of Shorts because they sit in the same minute of the same
 * topic. So each pick after the first is chosen on its score minus two
 * *bounded* discounts: one for the seconds it repeats, one for how much it
 * otherwise resembles what is already selected. Bounded is the whole point: a
 * clip better by more than the bounds always wins, so distinctness can break a
 * near-tie and can never cost the viewer the better Short.
 *
 * The overlap discount reaches its bound exactly where the duplicate bar
 * begins, so being refused outright is the limit of being charged rather than a
 * cliff a clip falls off.
 *
 * Deterministic throughout, including the tie-breaks, so the same input always
 * produces the same three clips in the same order.
 */

import type { ClipScore } from '@/domain';
import { clamp01, textSimilarity } from './text';
import type { ClipPlanDraft } from './construction';

export interface ScoredClipPlan {
  readonly draft: ClipPlanDraft;
  readonly score: ClipScore;
}

export type SelectionRejectionCode = 'duplicate_moment' | 'beyond_limit';

export interface RejectedSelection {
  readonly candidateClipId: string;
  readonly code: SelectionRejectionCode;
  readonly reason: string;
}

/** A selected clip, with what distinctness cost it on the way in. */
export interface SelectedClipPlan extends ScoredClipPlan {
  /** 1-based position in the final ranking. */
  readonly rank: number;
  /**
   * How much its score was discounted for resembling the clips already chosen,
   * 0..`maxDiversityDiscount`. Zero for the first pick, and for anything that
   * shares nothing with what came before.
   */
  readonly diversityDiscount: number;
  /**
   * How much its score was discounted for *repeating seconds* of a clip already
   * chosen, 0..`maxOverlapDiscount`. Zero unless the pair overlaps by more than
   * `maxOverlapRatio`, and reported apart from `diversityDiscount` because the
   * two answer different questions: this one is speech the viewer hears twice,
   * the other is a set of Shorts that feels narrow.
   */
  readonly overlapDiscount: number;
}

export interface SelectionResult {
  /** Ranked, best first. `rank` is the 1-based position. */
  readonly selected: readonly SelectedClipPlan[];
  readonly rejected: readonly RejectedSelection[];
}

export interface SelectionOptions {
  /** How many Shorts to return. The product targets 3. */
  readonly maxSelected?: number;
  /**
   * Overlap, as a share of the *shorter* clip, above which a plan starts paying
   * for the seconds it repeats. A tenth is deliberately strict: on a 30-second
   * Short that is already three seconds of speech the viewer hears twice. It is
   * a *price*, not a bar — what it may not do is decide the question before
   * quality has been looked at.
   */
  readonly maxOverlapRatio?: number;
  /**
   * Overlap, as a share of the shorter clip, at which two plans stop being
   * neighbours that share a sentence and become the same moment cut twice.
   * Above this a plan is refused however well it scores.
   *
   * Raised to `maxOverlapRatio` when that is set higher, so the two bars can
   * never cross and setting the soft bar to 1 still switches both off.
   */
  readonly duplicateOverlapRatio?: number;
  /** Content-word overlap above which two plans say the same thing. */
  readonly maxTextSimilarity?: number;
  /**
   * The most a clip's score may be discounted for resembling what is already
   * selected. This is a *bound*, and the point of it: a clip better by more
   * than this always wins, so variety can never override a materially stronger
   * Short. Set to 0 to rank on score alone.
   */
  readonly maxDiversityDiscount?: number;
  /**
   * The most a clip's score may be discounted for repeating seconds already
   * selected. Bounded for the same reason, and larger than the diversity bound
   * because speech heard twice is a worse fault than a narrow pair of subjects.
   */
  readonly maxOverlapDiscount?: number;
  /**
   * Gap, in seconds, beyond which two clips are simply different parts of the
   * video and proximity stops counting against the later one.
   */
  readonly nearbySeparationSec?: number;
}

const DEFAULTS = {
  maxSelected: 3,
  maxOverlapRatio: 0.1,
  // Two fifths of the shorter clip — around a quarter of a minute of a
  // half-minute Short — is past any reading of "they happen to share a
  // sentence". Observed overlaps sit either side of that with a wide gap: the
  // same moment cut twice lands at 0.7 and above, neighbours that share a
  // bridging line at 0.2 and below.
  duplicateOverlapRatio: 0.4,
  maxTextSimilarity: 0.6,
  // A tenth of the 0..1 scale: enough to break a near-tie towards variety,
  // far too little to unseat a clip that is genuinely better.
  maxDiversityDiscount: 0.08,
  maxOverlapDiscount: 0.12,
  nearbySeparationSec: 90,
} as const;

/**
 * Rank every plan, then take the strongest distinct ones.
 *
 * Three mechanisms, doing different jobs:
 *
 *  - **A hard filter.** Clips that are mostly the same seconds, or that say
 *    materially the same thing, are the same moment; the weaker one is rejected
 *    outright with the clip it duplicated named, so the choice is explainable.
 *    Nothing below can buy its way past this.
 *  - **A bounded overlap discount.** Clips that share more than
 *    `maxOverlapRatio` of the shorter span, but are under the duplicate bar, are
 *    *charged* rather than refused — by at most `maxOverlapDiscount`, scaled by
 *    how far into that band the overlap sits and lifted by how much the two also
 *    say the same thing. Sharing a bridging sentence is cheap; sharing a third
 *    of a Short is nearly the price of rejection.
 *  - **A bounded diversity discount.** Below every bar, resemblance is still a
 *    matter of degree, and each remaining clip is discounted — by at most
 *    `maxDiversityDiscount` — for how closely it otherwise resembles anything
 *    already chosen.
 *
 * Both discounts are capped, so a clip better by more than their sum is selected
 * regardless: distinctness breaks ties, it never overrules quality. That is what
 * separates a neighbouring moment worth shipping from a weaker clip that merely
 * had the good fortune not to overlap anything.
 *
 * Greedy and fully deterministic, including every tie-break: the same input
 * always produces the same clips in the same order.
 */
export function selectTopClips(
  scored: readonly ScoredClipPlan[],
  options: SelectionOptions = {},
): SelectionResult {
  const maxSelected = options.maxSelected ?? DEFAULTS.maxSelected;
  const maxOverlapRatio = options.maxOverlapRatio ?? DEFAULTS.maxOverlapRatio;
  const maxTextSimilarity = options.maxTextSimilarity ?? DEFAULTS.maxTextSimilarity;
  const maxDiversityDiscount = options.maxDiversityDiscount ?? DEFAULTS.maxDiversityDiscount;
  const maxOverlapDiscount = options.maxOverlapDiscount ?? DEFAULTS.maxOverlapDiscount;
  const nearbySeparationSec = options.nearbySeparationSec ?? DEFAULTS.nearbySeparationSec;
  // The bars may never cross: a clip cannot be charged for an overlap it has
  // already been rejected for, and `maxOverlapRatio: 1` still disables both.
  const duplicateOverlapRatio = Math.max(
    maxOverlapRatio,
    options.duplicateOverlapRatio ?? DEFAULTS.duplicateOverlapRatio,
  );

  const overlapPolicy: OverlapPolicy = {
    maxOverlapRatio,
    duplicateOverlapRatio,
    maxTextSimilarity,
    maxOverlapDiscount,
  };

  // Score order first, so every later comparison inherits a stable tie-break.
  const remaining = [...scored].sort(compareByScore);

  const selected: SelectedClipPlan[] = [];
  const rejected: RejectedSelection[] = [];

  while (selected.length < maxSelected && remaining.length > 0) {
    let best:
      | { entry: ScoredClipPlan; index: number; adjusted: number; diversity: number; overlap: number }
      | null = null;

    for (const [index, entry] of remaining.entries()) {
      if (
        selected.some((chosen) =>
          isSameMoment(chosen.draft, entry.draft, duplicateOverlapRatio, maxTextSimilarity),
        )
      ) {
        continue;
      }

      const diversity =
        selected.length === 0
          ? 0
          : diversityDiscount(entry.draft, selected, {
              maxTextSimilarity,
              maxDiversityDiscount,
              nearbySeparationSec,
            });
      const overlap = selected.length === 0 ? 0 : overlapDiscount(entry.draft, selected, overlapPolicy);
      const adjusted = entry.score.overall - diversity - overlap;

      // `remaining` is already in score order, so a plain `>` keeps the
      // existing tie-break (higher score, then earlier, then id) intact.
      if (best === null || adjusted > best.adjusted) best = { entry, index, adjusted, diversity, overlap };
    }

    if (best === null) break;

    remaining.splice(best.index, 1);
    selected.push({
      ...best.entry,
      rank: selected.length + 1,
      diversityDiscount: round4(best.diversity),
      overlapDiscount: round4(best.overlap),
    });
  }

  // Whatever is left was either ranked out or blocked. Rank dominates: once the
  // selection is full, nothing below it was ever in contention, whatever else
  // is true of it. Only when the loop ran out of distinct clips early is the
  // clash the actual reason, and then the clip it duplicated is named.
  const full = selected.length >= maxSelected;

  for (const entry of remaining) {
    const clash = full
      ? undefined
      : selected.find((chosen) =>
          isSameMoment(chosen.draft, entry.draft, duplicateOverlapRatio, maxTextSimilarity),
        );

    rejected.push(
      clash
        ? {
            candidateClipId: entry.draft.candidateClipId,
            code: 'duplicate_moment',
            reason: `Covers the same moment as the clip ranked ${clash.rank}.`,
          }
        : {
            candidateClipId: entry.draft.candidateClipId,
            code: 'beyond_limit',
            reason: `Ranked below the top ${maxSelected}.`,
          },
    );
  }

  return { selected, rejected };
}

/* -------------------------------------------------------------------------- */
/* Distinctness                                                               */
/* -------------------------------------------------------------------------- */

interface OverlapPolicy {
  readonly maxOverlapRatio: number;
  readonly duplicateOverlapRatio: number;
  readonly maxTextSimilarity: number;
  readonly maxOverlapDiscount: number;
}

/**
 * How much a clip's score is discounted for repeating seconds of a clip already
 * chosen, in score units, never more than `maxOverlapDiscount`.
 *
 * Two clips sharing seconds is not by itself a reason to drop one. Speech runs
 * continuously and a subject rarely changes on a clean edge, so the sentence
 * that closes one moment often opens the next; refusing every such pair throws
 * away real material and hands the slot to whatever happened not to touch
 * anything — which, in a video that opens on housekeeping, is usually the
 * housekeeping.
 *
 * So the charge is graduated. Its scale is *how much* of the shorter clip is
 * repeated, read across the band between the price bar and the duplicate bar,
 * so a clip about to be refused pays nearly the full bound and a clip sharing a
 * line pays almost nothing. Text resemblance then lifts that charge: repeating
 * seconds that also make the same point is the same content twice, while
 * repeating a bridge into a genuinely different subject is not.
 *
 * Taken against the *most* overlapped clip already selected, not the average —
 * one collision is enough.
 */
export function overlapDiscount(
  draft: ClipPlanDraft,
  selected: readonly { readonly draft: ClipPlanDraft }[],
  policy: OverlapPolicy,
): number {
  const band = policy.duplicateOverlapRatio - policy.maxOverlapRatio;
  if (selected.length === 0 || policy.maxOverlapDiscount <= 0 || band <= 0) return 0;

  let worst = 0;

  for (const chosen of selected) {
    const overlap = overlapRatio(chosen.draft, draft);
    if (overlap <= policy.maxOverlapRatio) continue;

    const shared = clamp01((overlap - policy.maxOverlapRatio) / band);
    // Scaled against the hard duplicate bar, exactly as `diversityDiscount`
    // scales it, so "says the same thing" means one thing in this file.
    const echo =
      policy.maxTextSimilarity > 0
        ? clamp01(textSimilarity(chosen.draft.text, draft.text) / policy.maxTextSimilarity)
        : 0;

    worst = Math.max(worst, shared * (SHARED_SECONDS_WEIGHT + (1 - SHARED_SECONDS_WEIGHT) * echo));
  }

  return policy.maxOverlapDiscount * clamp01(worst);
}

/**
 * How much of the overlap charge the repeated seconds carry on their own.
 *
 * The remainder is what saying the same thing adds. Weighted towards the
 * seconds because they are the fact — the viewer hears them twice whatever the
 * words are about — while text resemblance is an inference from a crude
 * content-word count.
 */
const SHARED_SECONDS_WEIGHT = 0.6;

interface DiversityPolicy {
  readonly maxTextSimilarity: number;
  readonly maxDiversityDiscount: number;
  readonly nearbySeparationSec: number;
}

/**
 * How much a clip's score is discounted for resembling the clips already
 * chosen, in score units, never more than `maxDiversityDiscount`.
 *
 * Three readings of "the same again", weighted by how strongly each one
 * predicts a viewer feeling they have seen this: what it says, what it is
 * about, and where it sits. Each is taken against the *most* similar clip
 * already selected, not the average — one collision is enough.
 */
export function diversityDiscount(
  draft: ClipPlanDraft,
  selected: readonly { readonly draft: ClipPlanDraft }[],
  policy: DiversityPolicy,
): number {
  if (selected.length === 0 || policy.maxDiversityDiscount <= 0) return 0;

  const worst = (measure: (chosen: ClipPlanDraft) => number): number =>
    selected.reduce((highest, chosen) => Math.max(highest, measure(chosen.draft)), 0);

  // Scaled against the hard duplicate bar, so similarity just under it is
  // nearly a full discount and unrelated wording is none.
  const similarity = worst((chosen) =>
    policy.maxTextSimilarity > 0 ? clamp01(textSimilarity(chosen.text, draft.text) / policy.maxTextSimilarity) : 0,
  );
  const topic = worst((chosen) => (sameTopic(chosen.topic, draft.topic) ? 1 : 0));
  const proximity = worst((chosen) => timelineProximity(chosen, draft, policy.nearbySeparationSec));

  const resemblance = clamp01(similarity * 0.55 + topic * 0.25 + proximity * 0.2);
  return policy.maxDiversityDiscount * resemblance;
}

/**
 * Closeness on the timeline, 1 when touching and 0 once `separationSec` apart.
 *
 * Adjacent moments are usually the same conversation continued, so two of them
 * make a thinner set of Shorts than two moments from different parts of the
 * video — even when neither overlaps the other by a single second.
 */
export function timelineProximity(
  a: { startSec: number; endSec: number },
  b: { startSec: number; endSec: number },
  separationSec: number,
): number {
  if (separationSec <= 0) return 0;

  const gap = Math.max(0, Math.max(a.startSec, b.startSec) - Math.min(a.endSec, b.endSec));
  return clamp01(1 - gap / separationSec);
}

/**
 * Highest score first. Ties break on the earlier clip, then on candidate id, so
 * ordering never depends on the order the plans arrived in.
 */
function compareByScore(a: ScoredClipPlan, b: ScoredClipPlan): number {
  if (b.score.overall !== a.score.overall) return b.score.overall - a.score.overall;
  if (a.draft.startSec !== b.draft.startSec) return a.draft.startSec - b.draft.startSec;
  return a.draft.candidateClipId.localeCompare(b.draft.candidateClipId);
}

/**
 * The same moment cut twice: mostly the same seconds, or the same words.
 *
 * The overlap bar here is the *duplicate* bar, not the bar above which a clip
 * starts paying for the seconds it repeats — see `overlapDiscount`. This
 * question has no appeal: a pair failing it is never shipped, whatever the two
 * clips score.
 */
export function isSameMoment(
  a: ClipPlanDraft,
  b: ClipPlanDraft,
  duplicateOverlapRatio: number,
  maxTextSimilarity: number,
): boolean {
  if (overlapRatio(a, b) > duplicateOverlapRatio) return true;
  if (sameTopic(a.topic, b.topic) && textSimilarity(a.text, b.text) > maxTextSimilarity / 2) return true;
  return textSimilarity(a.text, b.text) > maxTextSimilarity;
}

/** Overlapping seconds as a share of the shorter clip, 0..1. */
export function overlapRatio(
  a: { startSec: number; endSec: number },
  b: { startSec: number; endSec: number },
): number {
  const overlap = Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec);
  if (overlap <= 0) return 0;

  const shorter = Math.min(a.endSec - a.startSec, b.endSec - b.startSec);
  return shorter > 0 ? overlap / shorter : 0;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const sameTopic = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim().length > 0;
