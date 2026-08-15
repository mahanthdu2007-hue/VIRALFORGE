/**
 * Benchmark types: how a fixture is written, and what a run reports.
 *
 * Two vocabularies live here and they are deliberately separate.
 *
 *  - **Fixture types** are an *authoring* format. A fixture is written as lines
 *    of speech and moments expressed as line ranges, because a benchmark whose
 *    fixtures are hand-typed second offsets is a benchmark nobody edits. The
 *    builder turns that into a real `Transcript` with word timings.
 *  - **Report types** are the *comparison* format: a plain JSON tree with a
 *    version on it, so two runs of the pipeline — before and after a change to
 *    scoring, boundaries or ranking — can be diffed field by field.
 *
 * Nothing in this file measures anything. Every number in a report comes from
 * the production modules under `@/clips` and `@/validation`; the benchmark reads
 * their output and writes it down.
 */

import type { ClipScoreComponent, ClipScorePenalty, ClipSignals, ClipScoreWeights } from '@/domain';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** The kinds of source material the benchmark covers. */
export const BENCHMARK_GENRES = [
  'podcast-interview',
  'educational-explainer',
  'storytelling',
  'opinion-debate',
  'fast-conversational',
] as const;

export type BenchmarkGenre = (typeof BENCHMARK_GENRES)[number];

/** One line of speech. Becomes exactly one transcript segment. */
export interface FixtureLine {
  readonly text: string;
  /** Diarisation label, for fixtures with more than one voice. */
  readonly speaker?: string;
  /** Silence after this line. Defaults to the fixture's `gapSec`. */
  readonly pauseAfterSec?: number;
}

/**
 * A moment as discovery would propose it.
 *
 * Expressed as an inclusive line range rather than seconds, so editing a line
 * of speech never silently moves a candidate's boundaries. The overrides exist
 * for the one thing line ranges cannot express: a draft that is *meant* to be
 * rejected by validation.
 */
export interface FixtureCandidate {
  /** Stable label. Becomes the candidate id, so reports are readable. */
  readonly id: string;
  /** First line of the moment. */
  readonly fromLine: number;
  /** Last line of the moment, inclusive. */
  readonly toLine: number;
  readonly topic: string | null;
  readonly reason: string;
  /** Merged over `EMPTY_CLIP_SIGNALS`; omitted signals read as "not observed". */
  readonly signals?: Partial<ClipSignals>;
  /** Omit for a neutral 0.5; `null` models a provider that reports none. */
  readonly confidence?: number | null;
  /**
   * Omit to lead with the opening line verbatim. A string is used as written —
   * which is how a fixture exercises the verbatim guard.
   */
  readonly hookQuote?: string | null;
  /** Seconds, overriding the line range. Only for deliberate rejection cases. */
  readonly startSecOverride?: number;
  readonly endSecOverride?: number;
  /** Why this candidate is in the fixture. Reported, never scored. */
  readonly note?: string;
}

export interface BenchmarkFixture {
  readonly id: string;
  readonly genre: BenchmarkGenre;
  readonly title: string;
  /** What this fixture is meant to put pressure on. */
  readonly description: string;
  /** Speaking pace used to time every line. Genre-characteristic. */
  readonly wordsPerSecond: number;
  /** Default silence between lines. */
  readonly gapSec: number;
  /** Seconds of media after the last word — an outro, a fade. */
  readonly tailSec: number;
  readonly language: string;
  readonly lines: readonly FixtureLine[];
  readonly candidates: readonly FixtureCandidate[];
  /**
   * How many candidates a run may build. Below the accepted count on purpose:
   * preselection only does anything when the budget actually binds.
   */
  readonly buildBudget: number;
  /** How many Shorts to select. The product targets 3. */
  readonly maxSelected: number;
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Bump when the shape below changes incompatibly, so an old baseline is not
 * silently compared against a new report.
 */
export const BENCHMARK_FORMAT_VERSION = 1;

export interface StageRejection {
  /** The fixture's candidate label, or `unattributed` if it predates one. */
  readonly candidateId: string;
  readonly code: string;
  readonly reason: string;
}

/** What preselection read off one candidate, before any clip existed. */
export interface PreselectionReport {
  readonly candidateId: string;
  readonly confidence: number;
  /** What the text alone says, 0..1. */
  readonly textPromise: number;
  /** The blend of text and confidence that ordering uses, 0..1. */
  readonly promise: number;
  readonly selected: boolean;
  readonly signals: Readonly<Record<string, number>>;
}

/** Where a clip's boundaries landed, and how far they moved to get there. */
export interface BoundaryReport {
  readonly startSnap: string;
  readonly endSnap: string;
  readonly startsOnSentence: boolean;
  readonly endsOnSentence: boolean;
  readonly startShiftSec: number;
  readonly endShiftSec: number;
  readonly notes: readonly string[];
}

export interface ConstructedClipReport {
  readonly candidateId: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  /** Whether the runtime landed inside the 30–40s target window. */
  readonly withinTargetWindow: boolean;
  readonly wordCount: number;
  readonly wordsPerSecond: number;
  readonly maxGapSec: number;
  readonly segmentCount: number;
  readonly boundaries: BoundaryReport;
  readonly title: string;
  readonly hookQuote: string | null;
  /** Whether a validated model reading contributed to this clip's scores. */
  readonly aiAssisted: boolean;
}

export interface ScoreReport {
  readonly candidateId: string;
  readonly overall: number;
  readonly hook: number;
  readonly standalone: number;
  readonly emotion: number;
  readonly value: number;
  readonly components: Readonly<Record<ClipScoreComponent, number>>;
  readonly penalties: Readonly<Record<ClipScorePenalty, number>>;
  readonly componentTotal: number;
  readonly penaltyTotal: number;
  readonly rationale: string;
}

/** How the clip opens, gathered in one place because it is one judgement. */
export interface OpeningQualityReport {
  /** The scorer's hook component, 0..1. */
  readonly hook: number;
  /** The scorer's opening-cleanliness component, 0..1. */
  readonly opening: number;
  readonly hookQuote: string | null;
  /** Whether that quote is the clip's own first line, rather than lifted. */
  readonly quoteOpensClip: boolean;
  readonly startsOnSentence: boolean;
  readonly opensOnBoilerplate: boolean;
  readonly opensOnContinuation: boolean;
  readonly firstSentenceComplete: boolean;
  readonly firstSentenceWordCount: number;
}

/** How the clip lands. */
export interface EndingQualityReport {
  readonly payoff: number;
  readonly ending: number;
  readonly endsOnSentence: boolean;
  readonly endsOnSentencePunctuation: boolean;
  readonly endsOnDanglingWord: boolean;
  /** Payoff phrases in the closing lines — a landing rather than a setup. */
  readonly closingPayoffHits: number;
}

export interface RankedClipReport {
  readonly rank: number;
  readonly candidateId: string;
  readonly title: string;
  readonly topic: string | null;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly overall: number;
  /** What resembling the already-picked clips cost this one, in score units. */
  readonly diversityDiscount: number;
  readonly opening: OpeningQualityReport;
  readonly landing: EndingQualityReport;
}

/** One measured resemblance between two selected clips. */
export interface DiversityPairReport {
  readonly a: string;
  readonly b: string;
  readonly textSimilarity: number;
  readonly overlapRatio: number;
  readonly timelineProximity: number;
  readonly sameTopic: boolean;
  readonly gapSec: number;
}

export interface DiversityReport {
  readonly pairs: readonly DiversityPairReport[];
  readonly maxTextSimilarity: number;
  readonly maxOverlapRatio: number;
  readonly maxTimelineProximity: number;
  readonly distinctTopics: number;
  /** Smallest gap between any two selected clips, in seconds. */
  readonly minGapSec: number;
  /** Share of the media the selected clips are spread across, 0..1. */
  readonly timelineSpread: number;
}

export interface BenchmarkCaseResult {
  readonly fixtureId: string;
  readonly genre: BenchmarkGenre;
  readonly title: string;
  readonly description: string;
  readonly media: {
    readonly durationSec: number;
    readonly segmentCount: number;
    readonly wordCount: number;
    readonly wordsPerSecond: number;
  };
  readonly discovery: {
    readonly proposed: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly rejections: readonly StageRejection[];
  };
  readonly preselection: {
    readonly budget: number;
    readonly considered: number;
    readonly preselected: number;
    readonly skipped: number;
    readonly readings: readonly PreselectionReport[];
  };
  readonly construction: {
    readonly built: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly rejections: readonly StageRejection[];
    readonly clips: readonly ConstructedClipReport[];
  };
  readonly scoring: readonly ScoreReport[];
  readonly ranking: {
    readonly selected: readonly RankedClipReport[];
    readonly rejections: readonly StageRejection[];
  };
  readonly diversity: DiversityReport;
  /** Every candidate the fixture wrote, and what became of it. */
  readonly funnel: readonly {
    readonly candidateId: string;
    readonly note: string | null;
    readonly outcome: 'selected' | 'ranked-out' | 'not-preselected' | 'rejected';
    readonly stage: 'discovery' | 'preselection' | 'construction' | 'ranking';
    readonly detail: string;
  }[];
}

export interface BenchmarkReport {
  readonly formatVersion: number;
  readonly generator: string;
  /**
   * Whether a clip-refinement capability was wired in. `null` is the provider-
   * free baseline: every number below was reached by rules alone.
   */
  readonly refinement: string | null;
  /** The weights in force, so a report is interpretable on its own. */
  readonly weights: ClipScoreWeights;
  readonly cases: readonly BenchmarkCaseResult[];
  readonly totals: {
    readonly cases: number;
    readonly candidatesProposed: number;
    readonly candidatesAccepted: number;
    readonly candidatesRejected: number;
    readonly clipsBuilt: number;
    readonly clipsSelected: number;
    readonly meanSelectedOverall: number;
    readonly meanSelectedDurationSec: number;
    /** Selected clips inside the 30–40s target window, as a share of all. */
    readonly withinTargetWindowShare: number;
  };
}
