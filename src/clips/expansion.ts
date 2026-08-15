/**
 * Candidate expansion.
 *
 * Discovery models are good at pointing at *the* moment and bad at judging how
 * much runtime it needs: a strong beat is routinely reported as the 12–16
 * seconds in which the point is actually made, which is a real moment and not a
 * Short. Lowering the candidate minimum to admit those would let genuinely
 * unusable fragments through too, so instead the discovered moment is kept as
 * the **semantic centre** and the window is widened around it, using only
 * timings and speech the transcript already contains.
 *
 * Three rules shape this file, and they are the same ones that shape boundary
 * snapping:
 *
 *  1. **Nothing is invented.** Every boundary produced here is a timing that
 *     already exists in the transcript, and the extra speech the wider window
 *     picks up is verbatim by construction — this module never writes text.
 *  2. **The moment survives whole.** Expansion may only move the start earlier
 *     and the end later, so the span discovery pointed at is always inside the
 *     result. It can never be replaced by its surroundings.
 *  3. **Deterministic.** No model call, no randomness, ties broken towards the
 *     earlier anchor. The same transcript and the same moment always give the
 *     same window.
 *
 * Expansion runs *before* validation. It does not weaken validation: a moment
 * with nothing usable around it comes back unchanged and is rejected exactly as
 * it was before.
 */

import {
  CANDIDATE_MAX_DURATION_SEC,
  CANDIDATE_MIN_DURATION_SEC,
  SHORT_MAX_DURATION_SEC,
  SHORT_MIN_DURATION_SEC,
  type TimeRange,
  type Transcript,
} from '@/domain';
import type { CandidateClipDraft } from '@/ai/types';
import {
  DEFAULT_BOUNDARY_POLICY,
  endAnchors,
  startAnchors,
  toSpeechTokens,
  type BoundaryAnchor,
  type SpeechToken,
} from './boundaries';
import { measureSpeech } from './construction';
import { analyseText } from './text';

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What expansion is willing to trade for what.
 *
 * Costs are in seconds-equivalent, the same currency `BoundaryPolicy` uses, so
 * the two files can be read against each other. `incompleteSentenceCost` is
 * borrowed from the boundary policy outright rather than restated — a sentence
 * is worth the same here as it is there.
 */
export interface ExpansionPolicy {
  /** Below this the candidate is not usable and expansion is attempted. */
  readonly minDurationSec: number;
  /** The widest window expansion may produce. */
  readonly maxDurationSec: number;
  /** Preferred runtime window for the expanded candidate. */
  readonly targetMinSec: number;
  readonly targetMaxSec: number;
  /** The length aimed at inside that window. */
  readonly idealSec: number;
  /** How far, in seconds, expansion may reach on either side of the moment. */
  readonly reachSec: number;
  /** Cost of a boundary that cuts a sentence. */
  readonly incompleteSentenceCost: number;
  /** Cost per second of runtime outside the target window. */
  readonly durationMissCost: number;
  /** Cost per second away from the ideal length. A tie-break, not a driver. */
  readonly idealDriftCost: number;
  /** Cost per second of imbalance between what was added before and after. */
  readonly balanceCost: number;
  /** A silence at least this long reads as a break in the material. */
  readonly largePauseSec: number;
  /** Cost per second of silence beyond `largePauseSec` inside added speech. */
  readonly pauseCost: number;
  /** Cost of added speech that is entirely channel housekeeping. */
  readonly boilerplateCost: number;
  /** Extra cost for *opening* the clip on housekeeping. */
  readonly boilerplateOpeningCost: number;
}

export const DEFAULT_EXPANSION_POLICY: ExpansionPolicy = {
  minDurationSec: CANDIDATE_MIN_DURATION_SEC,
  maxDurationSec: CANDIDATE_MAX_DURATION_SEC,
  targetMinSec: SHORT_MIN_DURATION_SEC,
  targetMaxSec: SHORT_MAX_DURATION_SEC,
  idealSec: (SHORT_MIN_DURATION_SEC + SHORT_MAX_DURATION_SEC) / 2,
  reachSec: 25,
  incompleteSentenceCost: DEFAULT_BOUNDARY_POLICY.incompleteSentenceCost,
  // Deliberately larger than one-per-second: at 1/s a clean 20s window would
  // beat a 35s one that cuts a single sentence, and 20s is not the product.
  durationMissCost: 4,
  idealDriftCost: 0.05,
  balanceCost: 0.1,
  largePauseSec: 2,
  pauseCost: 8,
  boilerplateCost: 40,
  boilerplateOpeningCost: 30,
};

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

export interface ExpandedRange extends TimeRange {
  /** The span discovery pointed at, always contained by this range. */
  readonly moment: TimeRange;
  /** False when the moment was already long enough, or nothing usable was found. */
  readonly expanded: boolean;
  /** Machine-readable notes, e.g. `no_usable_expansion`. */
  readonly notes: readonly string[];
}

/**
 * Widen one discovered moment into a candidate window.
 *
 * @param tokens every speech token in the transcript, ordered — see `toSpeechTokens`
 * @param moment the discovered span, preserved whole inside the result
 * @param mediaDurationSec probed duration, never exceeded
 */
export function expandCandidateAroundMoment(
  tokens: readonly SpeechToken[],
  moment: TimeRange,
  mediaDurationSec: number,
  policy: ExpansionPolicy = DEFAULT_EXPANSION_POLICY,
): ExpandedRange {
  const unchanged = (notes: readonly string[]): ExpandedRange => ({
    startSec: moment.startSec,
    endSec: moment.endSec,
    moment,
    expanded: false,
    notes,
  });

  const duration = moment.endSec - moment.startSec;
  if (!Number.isFinite(duration) || duration <= 0) return unchanged(['invalid_moment']);
  if (duration >= policy.minDurationSec) return unchanged(['already_long_enough']);
  if (tokens.length === 0) return unchanged(['no_speech_tokens']);

  /* -- Where each side may land ------------------------------------------ */
  // Starts may only move earlier and ends only later, so the moment is inside
  // every pair considered. That is rule 2, enforced by the search space itself.
  const starts = withinReach(
    startAnchors(tokens),
    moment.startSec - policy.reachSec,
    moment.startSec,
  );
  const ends = withinReach(
    endAnchors(tokens),
    moment.endSec,
    Math.min(moment.endSec + policy.reachSec, mediaDurationSec),
  );

  if (starts.length === 0 || ends.length === 0) return unchanged(['no_expansion_anchors']);

  // Per-side cost is independent of the pairing, so it is computed once per
  // anchor rather than once per pair.
  const startCosts = starts.map((anchor) =>
    sideCost(tokens, anchor, anchor.atSec, moment.startSec, policy, true),
  );
  const endCosts = ends.map((anchor) =>
    sideCost(tokens, anchor, moment.endSec, anchor.atSec, policy, false),
  );

  /* -- Choose the pair ---------------------------------------------------- */
  let bestStart: BoundaryAnchor | null = null;
  let bestEnd: BoundaryAnchor | null = null;
  let bestCost = Infinity;

  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]!;
    const leadIn = moment.startSec - start.atSec;

    for (let j = 0; j < ends.length; j += 1) {
      const end = ends[j]!;
      const span = end.atSec - start.atSec;
      if (span < policy.minDurationSec || span > policy.maxDurationSec) continue;

      const tailOut = end.atSec - moment.endSec;
      const cost =
        startCosts[i]! +
        endCosts[j]! +
        policy.durationMissCost * targetMiss(span, policy) +
        policy.idealDriftCost * Math.abs(span - policy.idealSec) +
        policy.balanceCost * Math.abs(leadIn - tailOut);

      // Strict improvement only: ties keep the earliest pair, which makes the
      // choice stable for identical input.
      if (cost < bestCost) {
        bestCost = cost;
        bestStart = start;
        bestEnd = end;
      }
    }
  }

  // Nothing legal within reach. The moment is returned untouched and validation
  // rejects it on its own terms — expansion never manufactures a window.
  if (!bestStart || !bestEnd) return unchanged(['no_usable_expansion']);

  const notes: string[] = [];
  if (!bestStart.sentence) notes.push('start_not_on_sentence');
  if (!bestEnd.sentence) notes.push('end_not_on_sentence');

  return {
    startSec: round3(Math.max(0, bestStart.atSec)),
    endSec: round3(Math.min(bestEnd.atSec, mediaDurationSec)),
    moment,
    expanded: true,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* Draft-level entry point                                                    */
/* -------------------------------------------------------------------------- */

export interface ExpandedCandidateDraft {
  /** The draft with its range widened. Every other field is untouched. */
  readonly draft: CandidateClipDraft;
  readonly range: ExpandedRange;
}

/**
 * Expand a batch of discovery drafts against the transcript they came from.
 *
 * Flattens the transcript once and reuses it, because that is the expensive
 * part and every draft needs the same tokens.
 */
export function expandCandidateDrafts(
  drafts: readonly CandidateClipDraft[],
  transcript: Transcript,
  mediaDurationSec: number,
  policy: ExpansionPolicy = DEFAULT_EXPANSION_POLICY,
): readonly ExpandedCandidateDraft[] {
  const tokens = toSpeechTokens(transcript.segments);

  return drafts.map((draft) => {
    const range = expandCandidateAroundMoment(
      tokens,
      { startSec: draft.startSec, endSec: draft.endSec },
      mediaDurationSec,
      policy,
    );

    return {
      draft: range.expanded ? { ...draft, startSec: range.startSec, endSec: range.endSec } : draft,
      range,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Costs                                                                      */
/* -------------------------------------------------------------------------- */

/** How far a runtime falls outside the target window, in seconds. */
function targetMiss(durationSec: number, policy: ExpansionPolicy): number {
  if (durationSec < policy.targetMinSec) return policy.targetMinSec - durationSec;
  if (durationSec > policy.targetMaxSec) return durationSec - policy.targetMaxSec;
  return 0;
}

/**
 * What one side's expansion costs, ignoring runtime.
 *
 * This is where "do not wander off" lives. Three things make added speech a bad
 * neighbour for the moment, and all three are read off the transcript:
 *
 *  - **A long silence** inside the added span. Dead air is the one topic
 *    boundary a timed transcript exposes directly, so crossing one is expensive.
 *  - **Channel housekeeping.** A greeting, sign-off or sponsor read is verbatim
 *    speech that says nothing, and a Short that opens on one wastes its first
 *    seconds. Measured with the scorer's own boilerplate reading.
 * A boundary that cuts a sentence is charged the boundary policy's own price.
 *
 * There is deliberately **no word-overlap reading** of whether the added speech
 * is on the moment's subject. Jaccard similarity over a handful of seconds is
 * noise, and — because a longer span has more chances to share a word — it
 * scores *further* expansion as more relevant, which is the opposite of what is
 * wanted here. Staying on topic is instead bought by staying local: the reach
 * limit, the balance term and the pull towards `idealSec` together mean nothing
 * more than a few sentences either side is ever added.
 */
function sideCost(
  tokens: readonly SpeechToken[],
  anchor: BoundaryAnchor,
  fromSec: number,
  toSec: number,
  policy: ExpansionPolicy,
  isStart: boolean,
): number {
  let cost = anchor.sentence ? 0 : policy.incompleteSentenceCost;

  const addedSec = toSec - fromSec;
  if (addedSec <= 0) return cost;

  const gapSec = measureSpeech(tokens, { startSec: fromSec, endSec: toSec }).maxGapSec;
  if (gapSec > policy.largePauseSec) cost += policy.pauseCost * (gapSec - policy.largePauseSec);

  const added = speechBetween(tokens, fromSec, toSec);
  if (added.length === 0) return cost;

  const features = analyseText(added);
  cost += policy.boilerplateCost * features.boilerplateRatio;
  if (isStart && features.opensOnBoilerplate) cost += policy.boilerplateOpeningCost;

  return cost;
}

/* -------------------------------------------------------------------------- */

/** Anchors inside an inclusive window, in transcript order. */
const withinReach = (
  anchors: readonly BoundaryAnchor[],
  fromSec: number,
  toSec: number,
): readonly BoundaryAnchor[] => anchors.filter((a) => a.atSec >= fromSec && a.atSec <= toSec);

/**
 * Verbatim speech wholly inside a span.
 *
 * Token slices only — never a segment that merely overlaps the span, which
 * would attribute words to a window that does not contain them.
 */
function speechBetween(tokens: readonly SpeechToken[], fromSec: number, toSec: number): string {
  return tokens
    .filter((t) => t.startSec >= fromSec && t.endSec <= toSec)
    .map((t) => t.text)
    .join(' ')
    .trim();
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
