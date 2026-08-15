/**
 * Candidate preselection.
 *
 * Construction costs one provider call per clip, so a run can only build a
 * bounded number of the moments discovery found. Something has to choose which
 * ones, before any of them exist as clips.
 *
 * Model confidence alone is the wrong instrument for that choice. It is a
 * reading of "this looks like a moment", and a channel intro is reliably a very
 * confident-looking moment: greeting, complete sentences, clean edges, nothing
 * in it. Meanwhile the clip with the best hook in the video can arrive at 0.4
 * because the model was unsure where it ended. Cutting on confidence alone
 * therefore excludes exactly the candidates worth the call.
 *
 * So this module reads the candidate's own verbatim text — free, deterministic,
 * no provider — for the handful of properties that are visible before a clip is
 * built: does it open on something, does it finish, does it land somewhere, is
 * it housekeeping, does it lean on what came before it. That reading is blended
 * with confidence, and a share of the budget is reserved for what it rates
 * highest — see `preselectCandidates` for why both halves are needed.
 *
 * It also declines to spend two of a handful of build slots on the same moment.
 * Discovery routinely proposes one strong moment twice with different edges, and
 * both copies read well, so both are bought — and the clip that would have had
 * the third slot is never built at all. Ranking throws the second copy away
 * afterwards, which is too late to be any use: the slot is already spent. So
 * near-duplicates are identified here, cheaply, from signals that already exist
 * — see `partitionNearDuplicates`.
 *
 * **This is not scoring.** It never looks at boundaries, speech pace or model
 * semantics, because none of those exist yet — those are `scoreClip`'s inputs
 * and `scoreClip` remains the only thing that ranks clips. This is a cheaper,
 * blunter reading whose one job is to avoid throwing away a good moment before
 * the real scorer ever sees it. Where the two disagree, the scorer is right.
 * The same holds for duplicates: `selectTopClips` remains the authority on what
 * two Shorts may not have in common, and nothing here relaxes it.
 *
 * Deterministic throughout, tie-breaks included: the same candidates always
 * produce the same bounded set in the same order.
 */

import {
  candidateDuration,
  CANDIDATE_MAX_DURATION_SEC,
  CLIP_HARD_MIN_DURATION_SEC,
  SHORT_MIN_DURATION_SEC,
  type CandidateClip,
} from '@/domain';
import { overlapRatio, timelineProximity } from './ranking';
import { analyseText, clamp01, textSimilarity, type TextFeatures } from './text';

/** The cheap readings that go into a candidate's promise, each 0..1. */
export interface PreselectionSignals {
  /** Does the opening line earn the next few seconds? */
  readonly hook: number;
  /** Does it begin on a complete thought that does not point backwards? */
  readonly opening: number;
  /** Does it finish, rather than trail off mid-clause? */
  readonly ending: number;
  /** Is there a resolution in it, and does it sit near the end? */
  readonly payoff: number;
  /** Can a 30–40s Short plausibly be built from this span? */
  readonly duration: number;
  /** Greetings, sign-offs, calls to action. Higher is worse. */
  readonly boilerplate: number;
  /** Ums, ahs and padding. Higher is worse. */
  readonly filler: number;
  /** Leans on something said outside the span. Higher is worse. */
  readonly contextDependency: number;
}

/** One candidate's preselection reading, kept whole so a cut is explainable. */
export interface CandidatePromise {
  readonly candidate: CandidateClip;
  readonly signals: PreselectionSignals;
  /** What the text alone says, 0..1: merits less costs. */
  readonly textPromise: number;
  /** The confidence used, with `NEUTRAL_CONFIDENCE` standing in for null. */
  readonly confidence: number;
  /** The blend of the two that ordering actually uses, 0..1. */
  readonly promise: number;
}

export interface PreselectionOptions {
  /**
   * How much of the blend is the model's confidence. Deliberately the minority
   * share: confidence is one opinion about the moment, and the text is evidence
   * about it. Set to 1 to restore confidence-only ordering.
   */
  readonly confidenceWeight?: number;
  /**
   * Share of the build budget filled on the text reading alone, before the
   * blend fills the rest. Set to 0 to select purely on the blend.
   */
  readonly meritReserveShare?: number;
  /**
   * How near-duplicates are recognised. Pass `null` to spend the budget without
   * looking at duplication at all, which is what this module did before.
   */
  readonly duplicates?: DuplicatePolicy | null;
}

/**
 * When two candidates are the same moment found twice.
 *
 * Every bar here is *stricter* than the one `selectTopClips` enforces, and
 * deliberately so. Ranking judges built clips with settled boundaries and can
 * afford to reject on a tenth of a second of shared speech; this judges spans
 * that construction has not touched yet, where both edges will still move. A
 * false positive here costs a moment that is never built and never scored, so
 * the reading only fires when the two spans share most of their timeline *and*
 * most of their words.
 */
export interface DuplicatePolicy {
  /** Shared timeline, as a share of the shorter span, that starts to count. */
  readonly minOverlapRatio?: number;
  /** Content-word overlap that, together with the above, means one moment. */
  readonly minTextSimilarity?: number;
  /** The overlap bar when discovery gave both spans the same topic. */
  readonly minRelatedOverlapRatio?: number;
  /** The similarity bar when discovery gave both spans the same topic. */
  readonly minRelatedTextSimilarity?: number;
  /**
   * Similarity at which two spans are the same moment even without sharing much
   * timeline — the speaker making the same point twice in a row.
   */
  readonly minRestatementSimilarity?: number;
  /** How close, as `timelineProximity`, a restatement has to sit to count. */
  readonly minRestatementProximity?: number;
  /** Gap, in seconds, beyond which two spans are simply different moments. */
  readonly nearbySeparationSec?: number;
  /**
   * How far a duplicate's *text* reading may exceed the candidate it duplicates
   * before it is kept anyway. The guarantee that a clearly stronger candidate is
   * never set aside merely for sitting near another one.
   */
  readonly meritOverrideMargin?: number;
}

/**
 * What a missing confidence counts as.
 *
 * Neutral rather than zero: a provider that reports no confidence at all would
 * otherwise have every candidate tie at the bottom of the blend, which is a
 * quiet way of ignoring the text reading too.
 */
export const NEUTRAL_CONFIDENCE = 0.5;

const DEFAULTS = { confidenceWeight: 0.4, meritReserveShare: 1 / 3 } as const;

/**
 * The bars a pair has to clear to be one moment rather than two.
 *
 * Read against the benchmark's five transcripts, where the widest genuine
 * duplicate pair shares 76% of its timeline and 58% of its content words, and
 * the closest *distinct* pair shares 63% and 49%. The defaults sit in that gap,
 * on the conservative side of it.
 */
const DUPLICATE_DEFAULTS = {
  minOverlapRatio: 0.5,
  minTextSimilarity: 0.55,
  // A shared topic is discovery telling us these are the same subject, so the
  // evidence needed from the span and the words themselves is lower.
  minRelatedOverlapRatio: 0.35,
  minRelatedTextSimilarity: 0.45,
  minRestatementSimilarity: 0.8,
  // Back to back, not merely in the same minute: two spans a minute apart are
  // two moments however alike their wording is.
  minRestatementProximity: 0.9,
  nearbySeparationSec: 90,
  meritOverrideMargin: 0.1,
} as const;

/**
 * Relative weights of the positive readings. Not tuned against data — they
 * encode the same product opinion the scorer's weights do, at lower resolution:
 * a moment is worth building when it starts well and lands somewhere.
 */
const MERIT_WEIGHTS = {
  hook: 0.28,
  opening: 0.16,
  ending: 0.16,
  payoff: 0.26,
  duration: 0.14,
} as const;

/**
 * Costs, subtracted from the merit. Boilerplate dominates on purpose: it is the
 * failure this whole module exists for, and it is the one reading that can be
 * made confidently from text alone.
 */
const COST_WEIGHTS = {
  boilerplate: 0.3,
  contextDependency: 0.18,
  filler: 0.12,
} as const;

/** Housekeeping share at which the boilerplate cost saturates. */
const BOILERPLATE_SATURATION = 0.15;
/** Filler share at which the filler cost saturates. */
const FILLER_SATURATION = 0.12;
/** A span that *opens* on housekeeping is already half-costed on presence alone. */
const BOILERPLATE_OPENING_COST = 0.5;

/**
 * Choose which candidates are worth a construction call.
 *
 * The budget is filled in two passes, which exist for different reasons:
 *
 *  - **A merit reserve.** A share of the slots goes to the candidates whose text
 *    reads best, confidence ignored entirely. This is the guarantee the blend
 *    cannot make on its own: a wide enough confidence gap will always outvote a
 *    weighted text reading, and the moment that reads best in the whole video is
 *    exactly the one that must not be cut before it is ever built.
 *  - **The blend.** Everything else goes to the highest combined promise, where
 *    the model's confidence carries real weight — it knows things the text does
 *    not, and beyond a handful of clear readings the text is a blunt instrument.
 *
 * Both passes run over *representatives* — one candidate per moment, elected by
 * `partitionNearDuplicates`. A candidate set aside as a duplicate is not
 * discarded: if the two passes cannot fill the budget from representatives
 * alone, the duplicates fill what is left, most promising first. So the budget
 * is always spent in full, and it is spent on as many distinct moments as there
 * are to spend it on.
 *
 * Returns at most `limit` candidates in timeline order, so logs and any partial
 * failure still read chronologically. A set already inside the limit is returned
 * untouched: preselection exists to spend a bounded budget well, not to make a
 * small run smaller, and downstream ranking needs something to choose between.
 */
export function preselectCandidates(
  candidates: readonly CandidateClip[],
  limit: number,
  options: PreselectionOptions = {},
): readonly CandidateClip[] {
  if (candidates.length <= limit) return candidates;
  if (limit <= 0) return [];

  const assessed = candidates.map((candidate) => assessCandidate(candidate, options));
  const { representatives, duplicates } = partitionNearDuplicates(assessed, options.duplicates);

  const reserved = Math.min(
    limit,
    Math.round(limit * clamp01(options.meritReserveShare ?? DEFAULTS.meritReserveShare)),
  );

  const picked = new Map<string, CandidateClip>();
  const take = (entries: readonly CandidatePromise[], upTo: number): void => {
    for (const entry of entries) {
      if (picked.size >= upTo) return;
      picked.set(entry.candidate.id, entry.candidate);
    }
  };

  take([...representatives].sort(byMerit), reserved);
  take([...representatives].sort(byPromise), limit);
  // A no-op unless there were fewer distinct moments than slots. Spending a slot
  // on a second copy of a moment is a poor use of it; leaving it unspent is worse.
  take(
    duplicates.map((entry) => entry.reading),
    limit,
  );

  return [...picked.values()].sort((a, b) => a.startSec - b.startSec);
}

/* -------------------------------------------------------------------------- */
/* Duplicates                                                                 */
/* -------------------------------------------------------------------------- */

/** A candidate set aside, and the one it repeats. */
export interface NearDuplicateReading {
  readonly reading: CandidatePromise;
  /** Id of the representative it duplicates. */
  readonly duplicateOf: string;
}

export interface DuplicatePartition {
  /** One candidate per distinct moment, most promising first. */
  readonly representatives: readonly CandidatePromise[];
  /** The rest, most promising first, each naming what it repeats. */
  readonly duplicates: readonly NearDuplicateReading[];
}

/**
 * Split candidates into one-per-moment and the copies.
 *
 * Greedy, in promise order: the strongest candidate is a representative, and
 * each one after it is a representative unless it repeats a representative
 * already elected. Greedy rather than clustered on purpose — a candidate can
 * only be set aside by a moment that survived, so a chain of pairwise
 * resemblances cannot swallow a third, distinct moment at the end of it.
 *
 * Two guarantees come out of the ordering, and both matter:
 *
 *  - The candidate kept is the stronger of the pair, because the weaker one is
 *    always the one that arrives second.
 *  - A candidate whose *text* reads clearly better than the one it duplicates —
 *    `meritOverrideMargin` better — is kept regardless. Confidence is one
 *    opinion, and it is not allowed to cost a moment its only chance of being
 *    built on the strength of sitting near another one.
 *
 * Deterministic: ties break on the earlier candidate, then on id, exactly as
 * everywhere else in this module.
 */
export function partitionNearDuplicates(
  readings: readonly CandidatePromise[],
  policy: DuplicatePolicy | null | undefined = {},
): DuplicatePartition {
  const ordered = [...readings].sort(byPromise);
  if (policy === null) return { representatives: ordered, duplicates: [] };

  const margin = policy?.meritOverrideMargin ?? DUPLICATE_DEFAULTS.meritOverrideMargin;

  const representatives: CandidatePromise[] = [];
  const duplicates: NearDuplicateReading[] = [];

  for (const reading of ordered) {
    const clash = representatives.find(
      (kept) =>
        isNearDuplicateCandidate(kept.candidate, reading.candidate, policy) &&
        reading.textPromise <= kept.textPromise + margin,
    );

    if (clash) duplicates.push({ reading, duplicateOf: clash.candidate.id });
    else representatives.push(reading);
  }

  return { representatives, duplicates };
}

/**
 * Are these two spans the same moment, read before either exists as a clip?
 *
 * Three readings, all of them already computed elsewhere in the pipeline: how
 * much timeline the spans share, how many content words they share, and whether
 * discovery gave them the same topic. Nothing here re-derives any part of
 * `scoreClip` — there is no clip to score yet.
 *
 * Conjunctive by design. Overlapping spans on different subjects are a speaker
 * changing topic mid-sentence, and similar wording far apart is a speaker with
 * a vocabulary; neither on its own is a duplicate. Only sharing both the
 * timeline and the words is.
 */
export function isNearDuplicateCandidate(
  a: CandidateClip,
  b: CandidateClip,
  policy: DuplicatePolicy = {},
): boolean {
  const separation = policy.nearbySeparationSec ?? DUPLICATE_DEFAULTS.nearbySeparationSec;
  const proximity = timelineProximity(a, b, separation);
  const overlap = overlapRatio(a, b);
  if (overlap <= 0 && proximity <= 0) return false;

  const similarity = textSimilarity(a.text, b.text);

  // The same span, saying the same thing.
  if (
    overlap >= (policy.minOverlapRatio ?? DUPLICATE_DEFAULTS.minOverlapRatio) &&
    similarity >= (policy.minTextSimilarity ?? DUPLICATE_DEFAULTS.minTextSimilarity)
  ) {
    return true;
  }

  // The same span and the same subject: both bars relax, because discovery
  // naming one topic twice is evidence in its own right.
  if (
    sameTopic(a.topic, b.topic) &&
    overlap >= (policy.minRelatedOverlapRatio ?? DUPLICATE_DEFAULTS.minRelatedOverlapRatio) &&
    similarity >= (policy.minRelatedTextSimilarity ?? DUPLICATE_DEFAULTS.minRelatedTextSimilarity)
  ) {
    return true;
  }

  // Near-identical wording back to back: the point made twice in a row.
  return (
    similarity >= (policy.minRestatementSimilarity ?? DUPLICATE_DEFAULTS.minRestatementSimilarity) &&
    proximity >= (policy.minRestatementProximity ?? DUPLICATE_DEFAULTS.minRestatementProximity)
  );
}

const sameTopic = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.trim().length > 0 && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Every candidate, most promising first.
 *
 * Ties break on the earlier candidate, then on id — the same chain the rest of
 * the pipeline uses — so the order never depends on the order discovery
 * happened to return.
 */
export function rankCandidates(
  candidates: readonly CandidateClip[],
  options: PreselectionOptions = {},
): readonly CandidatePromise[] {
  return candidates.map((candidate) => assessCandidate(candidate, options)).sort(byPromise);
}

/** Highest blended promise first, then the earlier candidate, then id. */
const byPromise = (a: CandidatePromise, b: CandidatePromise): number =>
  b.promise - a.promise || stableTieBreak(a, b);

/** The same order, read on the text alone — what the merit reserve is filled by. */
const byMerit = (a: CandidatePromise, b: CandidatePromise): number =>
  b.textPromise - a.textPromise || stableTieBreak(a, b);

const stableTieBreak = (a: CandidatePromise, b: CandidatePromise): number =>
  a.candidate.startSec - b.candidate.startSec || a.candidate.id.localeCompare(b.candidate.id);

/** Read one candidate. Pure: text, duration, discovery signals, confidence. */
export function assessCandidate(
  candidate: CandidateClip,
  options: PreselectionOptions = {},
): CandidatePromise {
  const features = analyseText(candidate.text);
  const signals = measureSignals(candidate, features);

  const merit = weightedSum(MERIT_WEIGHTS, signals);
  const cost =
    COST_WEIGHTS.boilerplate * signals.boilerplate +
    COST_WEIGHTS.contextDependency * signals.contextDependency +
    COST_WEIGHTS.filler * signals.filler;

  const textPromise = clamp01(merit - cost);
  const confidence = candidate.confidence ?? NEUTRAL_CONFIDENCE;
  const confidenceWeight = clamp01(options.confidenceWeight ?? DEFAULTS.confidenceWeight);

  return {
    candidate,
    signals,
    textPromise: round4(textPromise),
    confidence,
    promise: round4(
      clamp01(confidenceWeight * clamp01(confidence) + (1 - confidenceWeight) * textPromise),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Readings                                                                   */
/* -------------------------------------------------------------------------- */

function measureSignals(candidate: CandidateClip, features: TextFeatures): PreselectionSignals {
  const { signals } = candidate;

  return {
    // The first line, read three ways: is it an opener at all, is it short
    // enough to land, and is it actually about something.
    hook: round3(
      mix([
        [features.opensOnHookWord ? 1 : 0.4, 0.3],
        [brevity(features.firstSentenceWordCount), 0.25],
        [signals.strongOpening ? 1 : 0.45, 0.25],
        [features.opensOnBoilerplate ? 0 : 1, 0.2],
      ]),
    ),
    opening: round3(
      mix([
        [features.firstSentenceComplete ? 1 : 0.3, 0.5],
        [features.opensOnContinuation || features.opensOnDeictic ? 0.25 : 1, 0.5],
      ]),
    ),
    ending: round3(
      mix([
        [features.endsOnSentencePunctuation ? 1 : 0.35, 0.6],
        [features.endsOnDanglingWord ? 0 : 1, 0.4],
      ]),
    ),
    // A resolution the discovery model saw, the words that usually carry one,
    // and — worth most — one of those words in the closing lines, which is the
    // difference between a clip that lands and a clip that sets something up.
    payoff: round3(
      mix([
        [signals.payoff ? 1 : 0.25, 0.35],
        [signals.questionAnswered ? 1 : 0.4, 0.15],
        [saturate(features.payoffHits, 2), 0.2],
        [saturate(features.closingPayoffHits, 1), 0.3],
      ]),
    ),
    duration: round3(candidateDurationFit(candidateDuration(candidate))),
    boilerplate: round3(
      clamp01(
        features.boilerplateRatio / BOILERPLATE_SATURATION +
          (features.opensOnBoilerplate ? BOILERPLATE_OPENING_COST : 0),
      ),
    ),
    filler: round3(clamp01(features.fillerRatio / FILLER_SATURATION)),
    contextDependency: round3(features.contextDependency),
  };
}

/**
 * How plausibly a 30–40s Short comes out of this span.
 *
 * Graded far more loosely than the scorer's `durationFit`, because a candidate
 * is not a clip yet: boundary snapping moves both edges and routinely turns a
 * 24-second span into a 32-second one. Only spans that cannot reach the hard
 * minimum, or run so long that construction must cut most of them away, are
 * marked down.
 */
export function candidateDurationFit(durationSec: number): number {
  if (durationSec >= SHORT_MIN_DURATION_SEC && durationSec <= CANDIDATE_MAX_DURATION_SEC) return 1;

  if (durationSec < SHORT_MIN_DURATION_SEC) {
    const span = SHORT_MIN_DURATION_SEC - CLIP_HARD_MIN_DURATION_SEC;
    // Half marks at the hard minimum: a short span is a lesser bet, not a
    // hopeless one, since the end boundary may extend past the candidate's.
    return clamp01(0.5 + (0.5 * (durationSec - CLIP_HARD_MIN_DURATION_SEC)) / span);
  }

  // Beyond the discovery window the span is a segment of video, not a moment.
  return clamp01(1 - (durationSec - CANDIDATE_MAX_DURATION_SEC) / CANDIDATE_MAX_DURATION_SEC);
}

/* -------------------------------------------------------------------------- */
/* Numeric helpers                                                            */
/* -------------------------------------------------------------------------- */

const weightedSum = (
  weights: Record<keyof typeof MERIT_WEIGHTS, number>,
  signals: PreselectionSignals,
): number =>
  (Object.keys(weights) as (keyof typeof MERIT_WEIGHTS)[]).reduce(
    (total, key) => total + weights[key] * clamp01(signals[key]),
    0,
  );

/** Weighted average of 0..1 parts. Weights are relative; they need not sum to 1. */
function mix(parts: readonly (readonly [number, number])[]): number {
  const totalWeight = parts.reduce((total, [, weight]) => total + weight, 0);
  if (totalWeight <= 0) return 0;
  return clamp01(parts.reduce((total, [value, weight]) => total + clamp01(value) * weight, 0) / totalWeight);
}

const saturate = (count: number, full: number): number => clamp01(count / full);

/** Shorter opening lines land harder; 12 words or fewer is full marks. */
const brevity = (words: number): number => (words === 0 ? 0 : clamp01(1 - Math.max(0, words - 12) / 20));

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
