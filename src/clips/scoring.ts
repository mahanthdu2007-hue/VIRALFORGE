/**
 * Clip scoring.
 *
 * A transparent weighted sum: each dimension is measured independently, in the
 * open, then combined by weights that live in `weights.ts`. Nothing here is a
 * black box and nothing is random — the same clip scores the same number every
 * time, which is what makes a ranking debuggable.
 *
 * **What the number is.** A relative quality measure used to order the moments
 * found in one video. It is not a prediction of views, engagement or virality,
 * and no part of this system presents it as one.
 *
 * **Where the model gets a say.** Optional, validated semantic hints blend 50/50
 * into the four dimensions a language model genuinely reads better than a word
 * list — curiosity, standing alone, payoff, context dependency. Everything else
 * is measured from the transcript. With no hints at all, scoring still works and
 * `aiAssisted` records that it ran without them.
 */

import {
  CLIP_SCORE_COMPONENTS,
  CLIP_SCORE_PENALTIES,
  SHORT_MAX_DURATION_SEC,
  SHORT_MIN_DURATION_SEC,
  CLIP_HARD_MAX_DURATION_SEC,
  CLIP_HARD_MIN_DURATION_SEC,
  type ClipScore,
  type ClipScoreBreakdown,
  type ClipScoreComponent,
  type ClipScorePenalty,
  type ClipScoreWeights,
  type ClipSignals,
  type ClipBoundaries,
} from '@/domain';
import { analyseText, clamp01, quoteOpensText, type TextFeatures } from './text';
import { DEFAULT_SCORE_WEIGHTS } from './weights';

/** Pace statistics measured off the transcript tokens inside the clip. */
export interface ClipSpeechStats {
  readonly wordCount: number;
  readonly wordsPerSecond: number;
  /** Longest silence between consecutive tokens, in seconds. */
  readonly maxGapSec: number;
}

/**
 * Validated semantic reading from the AI layer. Every field 0..1.
 * Null throughout when no provider supplied one, or its output was rejected.
 */
export interface SemanticHints {
  readonly curiosity: number;
  readonly standalone: number;
  readonly payoff: number;
  /** How much the clip needs surrounding context. Higher is worse. */
  readonly contextDependency: number;
}

/** Everything scoring reads. Deliberately a plain value: no repositories. */
export interface ScoringInput {
  readonly text: string;
  readonly durationSec: number;
  readonly signals: ClipSignals;
  /**
   * `startShiftSec` is optional: absent means "assume the start did not move",
   * which is what a caller scoring a hand-built clip means.
   */
  readonly boundaries: Pick<ClipBoundaries, 'startsOnSentence' | 'endsOnSentence'> &
    Partial<Pick<ClipBoundaries, 'startShiftSec'>>;
  readonly speech: ClipSpeechStats;
  readonly hookQuote: string | null;
  readonly semantic: SemanticHints | null;
}

/** Speech pace that reads as energetic without being rushed, in words/second. */
const COMFORTABLE_WPS = { min: 2.0, max: 3.6 } as const;
/** A pause longer than this is dead air a viewer feels. */
const DEAD_AIR_SEC = 2.5;

/** Filler share at which the filler penalty saturates. */
const FILLER_SATURATION = 0.12;
/** Repeated-trigram share at which the repetition penalty saturates. */
const REPETITION_SATURATION = 0.25;
/** Housekeeping share at which the boilerplate penalty saturates. */
const BOILERPLATE_SATURATION = 0.15;
/** A clip that *opens* on housekeeping is already half-penalised on presence alone. */
const BOILERPLATE_OPENING_COST = 0.5;

/**
 * How far the start may move from the candidate's before the discovery model's
 * `strongOpening` reading stops describing the clip that actually got built.
 */
const OPENING_TRUST_FREE_SHIFT_SEC = 1.5;
const OPENING_TRUST_ZERO_SHIFT_SEC = 6;
/** What `strongOpening` is worth once the start has moved past all trust. */
const UNTRUSTED_OPENING = 0.35;

export function scoreClip(input: ScoringInput, weights: ClipScoreWeights = DEFAULT_SCORE_WEIGHTS): ClipScore {
  const features = analyseText(input.text);

  const components = measureComponents(input, features);
  const penalties = measurePenalties(input, features);

  const componentTotal = CLIP_SCORE_COMPONENTS.reduce(
    (total, key) => total + components[key] * weights.components[key],
    0,
  );
  const penaltyTotal = CLIP_SCORE_PENALTIES.reduce(
    (total, key) => total + penalties[key] * weights.penalties[key],
    0,
  );

  const breakdown: ClipScoreBreakdown = {
    components,
    penalties,
    weights,
    componentTotal: round4(componentTotal),
    penaltyTotal: round4(penaltyTotal),
    aiAssisted: input.semantic !== null,
  };

  return {
    hook: components.hook,
    standalone: components.standalone,
    emotion: components.emotion,
    // The viewer-facing "value" axis is what they take away: facts plus payoff.
    value: round3(clamp01((components.information + components.payoff) / 2)),
    overall: round4(clamp01(componentTotal - penaltyTotal)),
    rationale: explain(components, penalties, weights),
    breakdown,
  };
}

/* -------------------------------------------------------------------------- */
/* Components                                                                 */
/* -------------------------------------------------------------------------- */

function measureComponents(
  input: ScoringInput,
  features: TextFeatures,
): Record<ClipScoreComponent, number> {
  const { signals, semantic } = input;

  // A clip that opens on a complete, short, attention-grabbing line, and has a
  // verified quote to lead with.
  const hook = mix([
    [openingStrength(input), 0.3],
    [features.opensOnHookWord ? 1 : 0.4, 0.15],
    [brevity(features.firstSentenceWordCount), 0.2],
    [hookQuoteCredit(input), 0.2],
    // "Hey guys, welcome back" is a complete, short, verbatim opening line, and
    // a wasted one — nothing above notices that, so it is priced here.
    [features.opensOnBoilerplate ? 0 : 1, 0.15],
  ]);

  const curiosityRule = mix([
    [signals.questionAnswered ? 1 : 0.3, 0.4],
    [saturate(features.questionCount, 2), 0.25],
    [saturate(features.curiosityHits, 4), 0.35],
  ]);

  const emotionRule = mix([
    [signals.emotionalIntensity, 0.55],
    [saturate(features.emotionHits, 4), 0.3],
    [saturate(features.exclamationCount, 2), 0.15],
  ]);

  const information = mix([
    [signals.informationDensity, 0.5],
    [features.lexicalVariety, 0.3],
    [saturate(features.numericRatio * 100, 6), 0.2],
  ]);

  const standaloneRule = mix([
    [signals.standalone, 0.5],
    [1 - features.contextDependency, 0.3],
    [input.boundaries.startsOnSentence && input.boundaries.endsOnSentence ? 1 : 0.4, 0.2],
  ]);

  const payoffRule = mix([
    [signals.payoff ? 1 : 0.25, 0.4],
    [signals.story ? 1 : 0.4, 0.15],
    [saturate(features.payoffHits, 2), 0.2],
    // Where the payoff sits matters: a resolution in the closing lines is the
    // clip landing, the same words in the first line are a setup for something
    // the viewer will not get to hear. Read as a strength rather than a phrase
    // count, so an ending that resolves without announcing itself still counts
    // and one that trails off or turns into a call to action does not.
    [features.payoffStrength, 0.25],
  ]);

  return finalise({
    hook,
    curiosity: blend(curiosityRule, semantic?.curiosity),
    emotion: emotionRule,
    information,
    standalone: blend(standaloneRule, semantic?.standalone),
    payoff: blend(payoffRule, semantic?.payoff),
    structure: structure(input, features),
    momentum: momentum(input.speech),
    opening: openingCleanliness(input, features),
    ending: endingCleanliness(input, features),
    duration: durationFit(input.durationSec),
  });
}

function measurePenalties(input: ScoringInput, features: TextFeatures): Record<ClipScorePenalty, number> {
  const contextRule = features.contextDependency;

  return {
    filler: round3(clamp01(features.fillerRatio / FILLER_SATURATION)),
    repetition: round3(clamp01(features.repetitionRatio / REPETITION_SATURATION)),
    contextDependency: round3(blend(contextRule, input.semantic?.contextDependency)),
    boilerplate: round3(
      clamp01(
        features.boilerplateRatio / BOILERPLATE_SATURATION +
          (features.opensOnBoilerplate ? BOILERPLATE_OPENING_COST : 0),
      ),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Shape of the clip                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Does the clip run as one whole thought?
 *
 * A Short that works has four beats — a hook, enough context to follow it,
 * some development, and a landing. This measures the shape rather than the
 * content: three separate readings, none of which any other component makes.
 *
 * Text-derived on purpose. It is the one dimension that must keep working when
 * the model reads nothing, because a fragment scored on its best sentence is
 * exactly the failure the rest of the scorer is blind to.
 */
function structure(input: ScoringInput, features: TextFeatures): number {
  // Opening: a first line that is complete and self-contained.
  const opening = mix([
    [features.firstSentenceComplete ? 1 : 0.3, 0.5],
    [features.opensOnContinuation || features.opensOnDeictic ? 0.25 : 1, 0.3],
    [features.opensOnBoilerplate ? 0 : 1, 0.2],
  ]);

  // Development: distinct beats, not one assertion held for forty seconds and
  // not a stream of fragments either.
  const development = mix([
    [saturate(features.sentenceCount, 3), 0.6],
    [1 - clamp01(features.repetitionRatio / REPETITION_SATURATION), 0.4],
  ]);

  // Landing: the last thing said finishes something.
  const landing = mix([
    [features.endsOnSentencePunctuation && input.boundaries.endsOnSentence ? 1 : 0.3, 0.5],
    [saturate(features.closingPayoffHits, 1), 0.3],
    [features.endsOnDanglingWord ? 0 : 1, 0.2],
  ]);

  return mix([
    [opening, 0.3],
    [development, 0.3],
    [landing, 0.4],
  ]);
}

/**
 * How cleanly the clip begins.
 *
 * Graded rather than binary: a boundary that lands on a sentence start is the
 * floor, not the goal — the sentence still has to be one a viewer can enter on.
 */
function openingCleanliness(input: ScoringInput, features: TextFeatures): number {
  if (!input.boundaries.startsOnSentence) return features.opensOnContinuation ? 0.2 : 0.3;

  let value = 1;
  if (features.opensOnContinuation) value -= 0.3;
  if (features.opensOnDeictic) value -= 0.25;
  if (features.opensOnBoilerplate) value -= 0.5;
  if (!features.firstSentenceComplete) value -= 0.2;

  return clamp01(value);
}

/**
 * How cleanly the clip ends.
 *
 * Two independent readings — where the boundary landed, and how the speech
 * itself reads — because they can disagree: snapping works on token timings,
 * and ASR punctuation is a separate guess. Agreement is full marks; one of the
 * two is a partial credit; a clip trailing off on "and" is close to nothing,
 * which is what it looks like to a viewer.
 */
function endingCleanliness(input: ScoringInput, features: TextFeatures): number {
  const boundaryClean = input.boundaries.endsOnSentence;
  const textClean = features.endsOnSentencePunctuation;

  if (boundaryClean && textClean) return 1;
  if (features.endsOnDanglingWord) return 0.1;
  if (boundaryClean || textClean) return 0.6;
  return 0.3;
}

/* -------------------------------------------------------------------------- */
/* Hook                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the discovery model's `strongOpening` reading is worth here.
 *
 * The flag describes the *candidate's* first line. Boundary snapping may then
 * have moved the start by several seconds, at which point the model is vouching
 * for a sentence this clip no longer opens on — so trust decays with the shift
 * rather than being taken at face value.
 */
function openingStrength(input: ScoringInput): number {
  if (!input.signals.strongOpening) return UNTRUSTED_OPENING;

  const shift = Math.abs(input.boundaries.startShiftSec ?? 0);
  const span = OPENING_TRUST_ZERO_SHIFT_SEC - OPENING_TRUST_FREE_SHIFT_SEC;
  const decayed = clamp01((shift - OPENING_TRUST_FREE_SHIFT_SEC) / span);

  return 1 - decayed * (1 - UNTRUSTED_OPENING);
}

/**
 * Credit for leading with a verified quote.
 *
 * Full marks only when the quote actually opens the clip. A traceable line
 * lifted from the middle is a good line, but the viewer hears the beginning,
 * so it cannot stand in for a hook.
 */
function hookQuoteCredit(input: ScoringInput): number {
  if (!input.hookQuote) return 0.4;
  return quoteOpensText(input.hookQuote, input.text) ? 1 : 0.6;
}

/**
 * Runtime fit: full marks inside the 30–40s target, falling linearly to zero at
 * the hard limits. Weighted lightly — a great 44s thought still beats a weak 35s
 * one, which is the point of allowing the wider range at all.
 */
export function durationFit(durationSec: number): number {
  if (durationSec >= SHORT_MIN_DURATION_SEC && durationSec <= SHORT_MAX_DURATION_SEC) return 1;

  if (durationSec < SHORT_MIN_DURATION_SEC) {
    const span = SHORT_MIN_DURATION_SEC - CLIP_HARD_MIN_DURATION_SEC;
    return clamp01((durationSec - CLIP_HARD_MIN_DURATION_SEC) / span);
  }

  const span = CLIP_HARD_MAX_DURATION_SEC - SHORT_MAX_DURATION_SEC;
  return clamp01((CLIP_HARD_MAX_DURATION_SEC - durationSec) / span);
}

/** Speech that moves: inside a comfortable pace band, with no dead air. */
function momentum(speech: ClipSpeechStats): number {
  const pace =
    speech.wordsPerSecond >= COMFORTABLE_WPS.min && speech.wordsPerSecond <= COMFORTABLE_WPS.max
      ? 1
      : speech.wordsPerSecond < COMFORTABLE_WPS.min
        ? clamp01(speech.wordsPerSecond / COMFORTABLE_WPS.min)
        : clamp01(1 - (speech.wordsPerSecond - COMFORTABLE_WPS.max) / COMFORTABLE_WPS.max);

  const silence = clamp01(1 - Math.max(0, speech.maxGapSec - 0.5) / DEAD_AIR_SEC);
  return mix([
    [pace, 0.7],
    [silence, 0.3],
  ]);
}

/* -------------------------------------------------------------------------- */
/* Explanation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A sentence naming what actually moved the number, built from the weighted
 * contributions. Generated text about the clip — never presented as speech.
 */
function explain(
  components: Record<ClipScoreComponent, number>,
  penalties: Record<ClipScorePenalty, number>,
  weights: ClipScoreWeights,
): string {
  const ranked = [...CLIP_SCORE_COMPONENTS].sort(
    (a, b) => components[b] * weights.components[b] - components[a] * weights.components[a],
  );

  const strengths = ranked.slice(0, 2).map((key) => `${LABELS[key]} (${components[key].toFixed(2)})`);
  const weakest = ranked.at(-1)!;

  const costly = [...CLIP_SCORE_PENALTIES]
    .filter((key) => penalties[key] * weights.penalties[key] >= 0.01)
    .sort((a, b) => penalties[b] * weights.penalties[b] - penalties[a] * weights.penalties[a])
    .map((key) => `${PENALTY_LABELS[key]} (${penalties[key].toFixed(2)})`);

  const parts = [`Strongest on ${strengths.join(' and ')}; weakest on ${LABELS[weakest]}.`];
  if (costly.length > 0) parts.push(`Penalised for ${costly.join(', ')}.`);

  return parts.join(' ');
}

const LABELS: Record<ClipScoreComponent, string> = {
  hook: 'hook',
  curiosity: 'curiosity',
  emotion: 'emotional intensity',
  information: 'information density',
  standalone: 'standing alone',
  payoff: 'payoff',
  structure: 'structure',
  momentum: 'momentum',
  opening: 'opening cleanliness',
  ending: 'ending cleanliness',
  duration: 'duration fit',
};

const PENALTY_LABELS: Record<ClipScorePenalty, string> = {
  filler: 'filler',
  repetition: 'repetition',
  contextDependency: 'context dependency',
  boilerplate: 'channel boilerplate',
};

/* -------------------------------------------------------------------------- */
/* Numeric helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Weighted average of 0..1 parts. Weights are relative; they need not sum to 1. */
function mix(parts: readonly (readonly [number, number])[]): number {
  const totalWeight = parts.reduce((total, [, weight]) => total + weight, 0);
  if (totalWeight <= 0) return 0;
  return clamp01(parts.reduce((total, [value, weight]) => total + clamp01(value) * weight, 0) / totalWeight);
}

/**
 * Blend a measured value with a model's reading of the same thing.
 *
 * Half each: the rule alone is blunt, the model alone is unverifiable. An absent
 * or rejected hint leaves the rule untouched.
 */
const blend = (rule: number, hint: number | undefined): number =>
  hint === undefined ? clamp01(rule) : clamp01((clamp01(rule) + clamp01(hint)) / 2);

/** `count` of something, worth full marks at `full` occurrences. */
const saturate = (count: number, full: number): number => clamp01(count / full);

/** Shorter opening lines land harder; 12 words or fewer is full marks. */
const brevity = (words: number): number => (words === 0 ? 0 : clamp01(1 - Math.max(0, words - 12) / 20));

const finalise = (values: Record<ClipScoreComponent, number>): Record<ClipScoreComponent, number> =>
  Object.fromEntries(
    CLIP_SCORE_COMPONENTS.map((key) => [key, round3(clamp01(values[key]))]),
  ) as Record<ClipScoreComponent, number>;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
