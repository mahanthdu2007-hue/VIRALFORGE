/**
 * The benchmark harness.
 *
 * Runs one fixture through the *production* clip stage — discovery output,
 * candidate validation, preselection, construction, plan validation, scoring,
 * ranking — and writes down what happened at each step. The stage order and the
 * arguments handed to each call mirror `runAnalysis` in `@/pipeline/analysis`;
 * what is left out is everything that needs a machine: no probe, no audio, no
 * transcription call, no repositories, no render.
 *
 * **Nothing here judges a clip.** Every number in a report is read off
 * `scoreClip`, `assessCandidate`, `selectTopClips` or `analyseText`. If the
 * benchmark and the pipeline ever disagree about a clip's quality, that is a bug
 * in this file, because this file has no opinion of its own to disagree with.
 *
 * Determinism is the whole point, so three things are pinned that the pipeline
 * leaves free: ids come from the fixture's own labels, the transcript's
 * timestamps are derived from the text, and no field carrying a wall clock is
 * ever copied into a report.
 */

import {
  CANDIDATE_MAX_DURATION_SEC,
  CANDIDATE_MIN_DURATION_SEC,
  isWithinShortDuration,
  type ClipScore,
} from '@/domain';
import type { ClipRefinementCapability } from '@/ai/types';
import { validateCandidates } from '@/validation/candidates';
import { validateClipPlans } from '@/validation/clip-plans';
import {
  analyseText,
  ClipConstruction,
  overlapRatio,
  preselectCandidates,
  quoteOpensText,
  rankCandidates,
  scoreClip,
  selectTopClips,
  textSimilarity,
  timelineProximity,
  type CandidatePromise,
  type ClipPlanDraft,
  type ScoredClipPlan,
  type SelectedClipPlan,
  type SelectionResult,
} from '@/clips';
import { DEFAULT_SCORE_WEIGHTS } from '@/clips/weights';
import { buildCandidates } from '@/storage/candidate-repository';
import {
  BENCHMARK_TRANSCRIPT_ID,
  BENCHMARK_VIDEO_ID,
  buildFixtureTranscript,
  fixtureDiscovery,
  labelFactory,
  toDraft,
  type BuiltFixture,
} from './transcript';
import {
  BENCHMARK_FORMAT_VERSION,
  type BenchmarkCaseResult,
  type BenchmarkFixture,
  type BenchmarkReport,
  type ConstructedClipReport,
  type DiversityPairReport,
  type DiversityReport,
  type EndingQualityReport,
  type OpeningQualityReport,
  type PreselectionReport,
  type RankedClipReport,
  type ScoreReport,
  type StageRejection,
} from './types';

export const BENCHMARK_GENERATOR = 'viralforge-clip-benchmark';

/**
 * Seconds beyond which ranking stops counting two clips as neighbours.
 *
 * Mirrors `selectTopClips`'s own default so the reported proximity is the one
 * selection actually used. Reporting only — selection is left on its defaults
 * rather than being told what they are.
 */
const NEARBY_SEPARATION_SEC = 90;

export interface BenchmarkOptions {
  /**
   * Optional clip-refinement capability, exactly as the pipeline takes one.
   * Omitted is the provider-free baseline: rules alone, `semantic: null`
   * throughout. Any capability passed must itself be deterministic and free.
   */
  readonly refinement?: ClipRefinementCapability | null;
  /** How the refinement is named in the report. */
  readonly refinementLabel?: string;
}

/* -------------------------------------------------------------------------- */
/* Running                                                                    */
/* -------------------------------------------------------------------------- */

/** Run every fixture and fold the results into one comparable report. */
export async function runBenchmark(
  fixtures: readonly BenchmarkFixture[],
  options: BenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const cases: BenchmarkCaseResult[] = [];
  // Sequential: construction is one provider call per clip in production, and
  // the benchmark should not model a concurrency the pipeline never uses.
  for (const fixture of fixtures) {
    cases.push(await runBenchmarkCase(fixture, options));
  }

  const selected = cases.flatMap((c) => c.ranking.selected);
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : round4(values.reduce((total, v) => total + v, 0) / values.length);

  return {
    formatVersion: BENCHMARK_FORMAT_VERSION,
    generator: BENCHMARK_GENERATOR,
    refinement: options.refinement ? (options.refinementLabel ?? 'unnamed') : null,
    weights: DEFAULT_SCORE_WEIGHTS,
    cases,
    totals: {
      cases: cases.length,
      candidatesProposed: sum(cases.map((c) => c.discovery.proposed)),
      candidatesAccepted: sum(cases.map((c) => c.discovery.accepted)),
      candidatesRejected: sum(cases.map((c) => c.discovery.rejected)),
      clipsBuilt: sum(cases.map((c) => c.construction.built)),
      clipsSelected: selected.length,
      meanSelectedOverall: mean(selected.map((s) => s.overall)),
      meanSelectedDurationSec: mean(selected.map((s) => s.durationSec)),
      withinTargetWindowShare:
        selected.length === 0
          ? 0
          : round4(selected.filter((s) => isWithinShortDuration(s.durationSec)).length / selected.length),
    },
  };
}

/** Run one fixture through the clip stage. */
export async function runBenchmarkCase(
  fixture: BenchmarkFixture,
  options: BenchmarkOptions = {},
): Promise<BenchmarkCaseResult> {
  const built = buildFixtureTranscript(fixture);
  const { transcript, mediaDurationSec } = built;

  /* -- Discover ---------------------------------------------------------- */
  const discovery = fixtureDiscovery(fixture, built);
  const drafts = await discovery.discoverClips({
    segments: transcript.segments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text })),
    videoDurationSec: mediaDurationSec,
    maxCandidates: fixture.candidates.length,
    targetDurationSec: { min: CANDIDATE_MIN_DURATION_SEC, max: CANDIDATE_MAX_DURATION_SEC },
    languageHint: fixture.language,
  });

  const labels = attributeDrafts(fixture, built, drafts);

  const { accepted, rejected } = validateCandidates(drafts, transcript, mediaDurationSec);

  // Validation is independent per draft, so re-running it one draft at a time
  // says which fixture candidate each verdict belongs to without the benchmark
  // guessing. `assertSameVerdicts` holds that assumption to account.
  const verdicts = drafts.map((draft, index) => ({
    label: labels[index]!,
    result: validateCandidates([draft], transcript, mediaDurationSec),
  }));
  assertSameVerdicts(fixture, accepted.length, rejected.length, verdicts);

  const acceptedLabels = verdicts.filter((v) => v.result.accepted.length === 1).map((v) => v.label);
  const discoveryRejections: StageRejection[] = verdicts
    .flatMap((v) => v.result.rejected.map((r) => ({ label: v.label, rejection: r })))
    .map(({ label, rejection }) => ({
      candidateId: label,
      code: rejection.code,
      reason: rejection.reason,
    }));

  const candidates = buildCandidates(
    accepted,
    BENCHMARK_VIDEO_ID,
    BENCHMARK_TRANSCRIPT_ID,
    labelFactory(acceptedLabels),
  );

  /* -- Preselect --------------------------------------------------------- */
  const preselected = preselectCandidates(candidates, fixture.buildBudget);
  const preselectedIds = new Set(preselected.map((c) => c.id));
  const readings = rankCandidates(candidates).map(
    (reading): PreselectionReport => toPreselectionReport(reading, preselectedIds.has(reading.candidate.id)),
  );

  /* -- Build ------------------------------------------------------------- */
  const construction = new ClipConstruction(transcript, mediaDurationSec, {
    refinement: options.refinement ?? null,
  });
  const planDrafts = await construction.constructAll(preselected);
  const planCheck = validateClipPlans(planDrafts, mediaDurationSec);

  /* -- Score ------------------------------------------------------------- */
  // Field for field what `runAnalysis` passes, so the benchmark cannot score a
  // clip on inputs the pipeline would not have given it.
  const scored: ScoredClipPlan[] = planCheck.accepted.map((draft) => ({
    draft,
    score: scoreClip({
      text: draft.text,
      durationSec: draft.durationSec,
      signals: draft.signals,
      boundaries: draft.boundaries,
      speech: draft.speech,
      hookQuote: draft.hookQuote,
      semantic: draft.semantic,
    }),
  }));

  /* -- Rank -------------------------------------------------------------- */
  const selection = selectTopClips(scored, { maxSelected: fixture.maxSelected });

  /* -- Report ------------------------------------------------------------ */
  const scoreOf = new Map(scored.map((entry) => [entry.draft.candidateClipId as string, entry.score]));

  return {
    fixtureId: fixture.id,
    genre: fixture.genre,
    title: fixture.title,
    description: fixture.description,
    media: {
      durationSec: mediaDurationSec,
      segmentCount: transcript.segments.length,
      wordCount: built.wordCount,
      wordsPerSecond: fixture.wordsPerSecond,
    },
    discovery: {
      proposed: drafts.length,
      accepted: accepted.length,
      rejected: rejected.length,
      rejections: discoveryRejections,
    },
    preselection: {
      budget: fixture.buildBudget,
      considered: candidates.length,
      preselected: preselected.length,
      skipped: candidates.length - preselected.length,
      readings,
    },
    construction: {
      built: planDrafts.length,
      accepted: planCheck.accepted.length,
      rejected: planCheck.rejected.length,
      rejections: planCheck.rejected.map((r) => ({
        candidateId: r.candidateClipId,
        code: r.code,
        reason: r.reason,
      })),
      clips: planCheck.accepted.map((draft) =>
        toConstructedReport(draft, scoreOf.get(draft.candidateClipId as string) ?? null),
      ),
    },
    scoring: scored.map(({ draft, score }) => toScoreReport(draft, score)),
    ranking: {
      selected: selection.selected.map(toRankedReport),
      rejections: selection.rejected.map((r) => ({
        candidateId: r.candidateClipId,
        code: r.code,
        reason: r.reason,
      })),
    },
    diversity: measureDiversity(selection.selected, mediaDurationSec),
    funnel: buildFunnel(fixture, {
      discoveryRejections,
      acceptedLabels,
      preselectedIds,
      planRejections: planCheck.rejected.map((r) => ({
        candidateId: r.candidateClipId,
        code: r.code,
        reason: r.reason,
      })),
      selection,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Report builders                                                            */
/* -------------------------------------------------------------------------- */

const toPreselectionReport = (reading: CandidatePromise, selected: boolean): PreselectionReport => ({
  candidateId: reading.candidate.id,
  confidence: reading.confidence,
  textPromise: reading.textPromise,
  promise: reading.promise,
  selected,
  signals: { ...reading.signals },
});

function toConstructedReport(draft: ClipPlanDraft, score: ClipScore | null): ConstructedClipReport {
  return {
    candidateId: draft.candidateClipId,
    startSec: draft.startSec,
    endSec: draft.endSec,
    durationSec: draft.durationSec,
    withinTargetWindow: isWithinShortDuration(draft.durationSec),
    wordCount: draft.speech.wordCount,
    wordsPerSecond: draft.speech.wordsPerSecond,
    maxGapSec: draft.speech.maxGapSec,
    segmentCount: draft.segmentIds.length,
    boundaries: {
      startSnap: draft.boundaries.startSnap,
      endSnap: draft.boundaries.endSnap,
      startsOnSentence: draft.boundaries.startsOnSentence,
      endsOnSentence: draft.boundaries.endsOnSentence,
      startShiftSec: draft.boundaries.startShiftSec,
      endShiftSec: draft.boundaries.endShiftSec,
      notes: draft.boundaries.notes,
    },
    title: draft.title,
    hookQuote: draft.hookQuote,
    aiAssisted: score?.breakdown.aiAssisted ?? draft.semantic !== null,
  };
}

const toScoreReport = (draft: ClipPlanDraft, score: ClipScore): ScoreReport => ({
  candidateId: draft.candidateClipId,
  overall: score.overall,
  hook: score.hook,
  standalone: score.standalone,
  emotion: score.emotion,
  value: score.value,
  components: score.breakdown.components,
  penalties: score.breakdown.penalties,
  componentTotal: score.breakdown.componentTotal,
  penaltyTotal: score.breakdown.penaltyTotal,
  rationale: score.rationale,
});

function toRankedReport(entry: SelectedClipPlan): RankedClipReport {
  const { draft, score } = entry;

  return {
    rank: entry.rank,
    candidateId: draft.candidateClipId,
    title: draft.title,
    topic: draft.topic,
    startSec: draft.startSec,
    endSec: draft.endSec,
    durationSec: draft.durationSec,
    overall: score.overall,
    diversityDiscount: entry.diversityDiscount,
    opening: openingQuality(draft, score),
    landing: endingQuality(draft, score),
  };
}

/**
 * How the clip opens.
 *
 * The two numbers are the scorer's own; the flags beside them are the text
 * features that produced them, so a weak hook in a report can be read without
 * re-deriving anything.
 */
function openingQuality(draft: ClipPlanDraft, score: ClipScore): OpeningQualityReport {
  const features = analyseText(draft.text);

  return {
    hook: score.breakdown.components.hook,
    opening: score.breakdown.components.opening,
    hookQuote: draft.hookQuote,
    quoteOpensClip: draft.hookQuote !== null && quoteOpensText(draft.hookQuote, draft.text),
    startsOnSentence: draft.boundaries.startsOnSentence,
    opensOnBoilerplate: features.opensOnBoilerplate,
    opensOnContinuation: features.opensOnContinuation,
    firstSentenceComplete: features.firstSentenceComplete,
    firstSentenceWordCount: features.firstSentenceWordCount,
  };
}

/** How the clip lands, read the same way. */
function endingQuality(draft: ClipPlanDraft, score: ClipScore): EndingQualityReport {
  const features = analyseText(draft.text);

  return {
    payoff: score.breakdown.components.payoff,
    ending: score.breakdown.components.ending,
    endsOnSentence: draft.boundaries.endsOnSentence,
    endsOnSentencePunctuation: features.endsOnSentencePunctuation,
    endsOnDanglingWord: features.endsOnDanglingWord,
    closingPayoffHits: features.closingPayoffHits,
  };
}

/**
 * How different the selected Shorts actually are from one another.
 *
 * Measured with the same three functions `selectTopClips` uses to discount for
 * resemblance, so the report and the selection cannot drift apart. This is the
 * dimension a scoring change is most likely to break silently: three clips can
 * each score well and still be the same forty seconds three times.
 */
function measureDiversity(
  selected: readonly SelectedClipPlan[],
  mediaDurationSec: number,
): DiversityReport {
  const pairs: DiversityPairReport[] = [];

  for (let i = 0; i < selected.length; i += 1) {
    for (let j = i + 1; j < selected.length; j += 1) {
      const a = selected[i]!.draft;
      const b = selected[j]!.draft;

      pairs.push({
        a: a.candidateClipId,
        b: b.candidateClipId,
        textSimilarity: round4(textSimilarity(a.text, b.text)),
        overlapRatio: round4(overlapRatio(a, b)),
        timelineProximity: round4(timelineProximity(a, b, NEARBY_SEPARATION_SEC)),
        sameTopic: sameTopic(a.topic, b.topic),
        gapSec: round3(Math.max(0, Math.max(a.startSec, b.startSec) - Math.min(a.endSec, b.endSec))),
      });
    }
  }

  const topics = new Set(selected.map((s) => (s.draft.topic ?? ` ${s.draft.candidateClipId}`).toLowerCase()));
  const starts = selected.map((s) => s.draft.startSec);
  const ends = selected.map((s) => s.draft.endSec);

  return {
    pairs,
    maxTextSimilarity: highest(pairs.map((p) => p.textSimilarity)),
    maxOverlapRatio: highest(pairs.map((p) => p.overlapRatio)),
    maxTimelineProximity: highest(pairs.map((p) => p.timelineProximity)),
    distinctTopics: topics.size,
    minGapSec: pairs.length === 0 ? 0 : Math.min(...pairs.map((p) => p.gapSec)),
    timelineSpread:
      selected.length < 2 || mediaDurationSec <= 0
        ? 0
        : round4((Math.max(...ends) - Math.min(...starts)) / mediaDurationSec),
  };
}

/** Every candidate the fixture wrote, and where it stopped. */
function buildFunnel(
  fixture: BenchmarkFixture,
  outcome: {
    readonly discoveryRejections: readonly StageRejection[];
    readonly acceptedLabels: readonly string[];
    readonly preselectedIds: ReadonlySet<string>;
    readonly planRejections: readonly StageRejection[];
    readonly selection: SelectionResult;
  },
): BenchmarkCaseResult['funnel'] {
  return fixture.candidates.map((candidate) => {
    const note = candidate.note ?? null;
    const discoveryRejection = outcome.discoveryRejections.find((r) => r.candidateId === candidate.id);
    if (discoveryRejection) {
      return {
        candidateId: candidate.id,
        note,
        outcome: 'rejected' as const,
        stage: 'discovery' as const,
        detail: `${discoveryRejection.code}: ${discoveryRejection.reason}`,
      };
    }

    if (!outcome.preselectedIds.has(candidate.id)) {
      return {
        candidateId: candidate.id,
        note,
        outcome: 'not-preselected' as const,
        stage: 'preselection' as const,
        detail: `Outside the build budget of ${fixture.buildBudget}.`,
      };
    }

    const planRejection = outcome.planRejections.find((r) => r.candidateId === candidate.id);
    if (planRejection) {
      return {
        candidateId: candidate.id,
        note,
        outcome: 'rejected' as const,
        stage: 'construction' as const,
        detail: `${planRejection.code}: ${planRejection.reason}`,
      };
    }

    const chosen = outcome.selection.selected.find((s) => s.draft.candidateClipId === candidate.id);
    if (chosen) {
      return {
        candidateId: candidate.id,
        note,
        outcome: 'selected' as const,
        stage: 'ranking' as const,
        detail: `Ranked ${chosen.rank} at ${chosen.score.overall.toFixed(4)}.`,
      };
    }

    const rankedOut = outcome.selection.rejected.find((r) => r.candidateClipId === candidate.id);
    return {
      candidateId: candidate.id,
      note,
      outcome: 'ranked-out' as const,
      stage: 'ranking' as const,
      detail: rankedOut ? `${rankedOut.code}: ${rankedOut.reason}` : 'Not selected.',
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Attribution                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which fixture candidate each returned draft is.
 *
 * Discovery returns drafts in timeline order, not the order the fixture wrote
 * them, and a draft carries no id — so the labels are recovered by ordering the
 * fixture's own candidates the same way and checking the boundaries line up.
 * A mismatch is a bug in the fixture or the builder, and it fails loudly rather
 * than mislabelling a whole report.
 */
function attributeDrafts(
  fixture: BenchmarkFixture,
  built: BuiltFixture,
  drafts: readonly { readonly startSec: number; readonly endSec: number }[],
): readonly string[] {
  const ordered = fixture.candidates
    .map((candidate) => ({ id: candidate.id, draft: toDraft(fixture, built, candidate) }))
    .sort((a, b) => a.draft.startSec - b.draft.startSec || a.draft.endSec - b.draft.endSec);

  if (ordered.length !== drafts.length) {
    throw new Error(`Fixture ${fixture.id}: discovery returned ${drafts.length} of ${ordered.length} moments.`);
  }

  return ordered.map((entry, index) => {
    const draft = drafts[index]!;
    if (draft.startSec !== entry.draft.startSec || draft.endSec !== entry.draft.endSec) {
      throw new Error(
        `Fixture ${fixture.id}: could not attribute the draft at ${draft.startSec}s–${draft.endSec}s.`,
      );
    }
    return entry.id;
  });
}

/** The per-draft re-run must agree with the batch, or attribution is fiction. */
function assertSameVerdicts(
  fixture: BenchmarkFixture,
  accepted: number,
  rejected: number,
  verdicts: readonly { readonly result: { accepted: readonly unknown[]; rejected: readonly unknown[] } }[],
): void {
  const perDraftAccepted = sum(verdicts.map((v) => v.result.accepted.length));
  const perDraftRejected = sum(verdicts.map((v) => v.result.rejected.length));

  if (perDraftAccepted !== accepted || perDraftRejected !== rejected) {
    throw new Error(
      `Fixture ${fixture.id}: candidate validation is not per-draft independent ` +
        `(${accepted}/${rejected} in batch, ${perDraftAccepted}/${perDraftRejected} singly).`,
    );
  }
}

/* -------------------------------------------------------------------------- */

const sameTopic = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.trim().length > 0 && a.trim().toLowerCase() === b.trim().toLowerCase();

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const highest = (values: readonly number[]): number => (values.length === 0 ? 0 : Math.max(...values));
const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
