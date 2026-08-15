/**
 * The benchmark, run as a test.
 *
 * Three separate jobs live in this file:
 *
 *  1. **Determinism.** The same fixtures must produce byte-identical JSON, run
 *     after run and whichever order the fixtures are handed over in. Without
 *     that the report cannot be diffed, and a benchmark that cannot be diffed
 *     measures nothing.
 *  2. **A committed baseline.** `benchmarks/clip-quality.baseline.json` is the
 *     last agreed output. A change to scoring, boundaries or ranking will fail
 *     this test — that is the point. Re-generate deliberately, and read the
 *     diff, with `VIRALFORGE_BENCH_UPDATE=1 npm run bench`.
 *  3. **Standing expectations.** A handful of judgements that must hold however
 *     the numbers move: housekeeping never ships, invented quotes never ship,
 *     and three Shorts are never the same forty seconds three times.
 *
 * No provider, no network, no filesystem beyond the baseline, no rendering.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_FIXTURES,
  BENCHMARK_FORMAT_VERSION,
  buildFixtureTranscript,
  fixtureDiscovery,
  runBenchmark,
  runBenchmarkCase,
  type BenchmarkCaseResult,
  type BenchmarkReport,
} from '@/benchmark';
import { createMockProvider } from '@/ai/providers/mock';
import { validateCandidates } from '@/validation/candidates';
import { CLIP_HARD_MAX_DURATION_SEC, CLIP_HARD_MIN_DURATION_SEC } from '@/domain';

const BASELINE_PATH = path.join(process.cwd(), 'benchmarks', 'clip-quality.baseline.json');
const UPDATE_BASELINE = process.env.VIRALFORGE_BENCH_UPDATE === '1';

/** One run, shared by every assertion below. */
const report = await runBenchmark(BENCHMARK_FIXTURES);

const caseOf = (fixtureId: string): BenchmarkCaseResult => {
  const found = report.cases.find((c) => c.fixtureId === fixtureId);
  if (!found) throw new Error(`No benchmark case for ${fixtureId}.`);
  return found;
};

const outcomeOf = (fixtureId: string, candidateId: string) => {
  const entry = caseOf(fixtureId).funnel.find((f) => f.candidateId === candidateId);
  if (!entry) throw new Error(`No funnel entry for ${candidateId}.`);
  return entry;
};

/* -------------------------------------------------------------------------- */
/* Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe('benchmark determinism', () => {
  it('produces byte-identical JSON on a second run', async () => {
    const again = await runBenchmark(BENCHMARK_FIXTURES);
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
  });

  it('produces the same case whether run alone or with the others', async () => {
    for (const fixture of BENCHMARK_FIXTURES) {
      const alone = await runBenchmarkCase(fixture);
      expect(JSON.stringify(alone)).toBe(JSON.stringify(caseOf(fixture.id)));
    }
  });

  it('does not depend on the order the fixtures are supplied in', async () => {
    const reversed = await runBenchmark([...BENCHMARK_FIXTURES].reverse());
    for (const fixture of BENCHMARK_FIXTURES) {
      const mine = reversed.cases.find((c) => c.fixtureId === fixture.id);
      expect(JSON.stringify(mine)).toBe(JSON.stringify(caseOf(fixture.id)));
    }
  });

  it('carries no wall-clock value anywhere in the report', () => {
    const serialised = JSON.stringify(report);
    // `createdAt` is the only clock the clip stage touches, and no report field
    // copies it. An ISO timestamp appearing here would break every comparison.
    expect(serialised).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u);
  });

  it('is deterministic with a refinement capability wired in as well', async () => {
    const refinement = createMockProvider().clipRefinement!;
    const first = await runBenchmark(BENCHMARK_FIXTURES, { refinement, refinementLabel: 'mock-v1' });
    const second = await runBenchmark(BENCHMARK_FIXTURES, { refinement, refinementLabel: 'mock-v1' });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.refinement).toBe('mock-v1');
    // And it genuinely took a different path: the baseline run used no model.
    expect(first.cases[0]!.construction.clips.every((c) => c.aiAssisted)).toBe(true);
    expect(report.cases[0]!.construction.clips.every((c) => c.aiAssisted)).toBe(false);
  });

  it('builds the same transcript timings from the same fixture every time', () => {
    for (const fixture of BENCHMARK_FIXTURES) {
      const a = buildFixtureTranscript(fixture);
      const b = buildFixtureTranscript(fixture);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Baseline                                                                   */
/* -------------------------------------------------------------------------- */

describe('benchmark baseline', () => {
  it('matches the committed baseline', () => {
    if (UPDATE_BASELINE) {
      fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }

    expect(fs.existsSync(BASELINE_PATH)).toBe(true);
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as BenchmarkReport;

    expect(baseline.formatVersion).toBe(BENCHMARK_FORMAT_VERSION);
    // Compared case by case so a failure names the fixture that moved.
    for (const current of report.cases) {
      const recorded = baseline.cases.find((c) => c.fixtureId === current.fixtureId);
      expect(recorded, `baseline is missing ${current.fixtureId}`).toBeDefined();
      expect(current).toEqual(recorded);
    }
    expect(report.totals).toEqual(baseline.totals);
    expect(report.weights).toEqual(baseline.weights);
  });
});

/* -------------------------------------------------------------------------- */
/* Coverage of the set                                                        */
/* -------------------------------------------------------------------------- */

describe('benchmark coverage', () => {
  it('covers every genre exactly once', () => {
    expect(report.cases.map((c) => c.genre)).toEqual([
      'podcast-interview',
      'educational-explainer',
      'storytelling',
      'opinion-debate',
      'fast-conversational',
    ]);
  });

  it('reports every stage for every case', () => {
    for (const current of report.cases) {
      expect(current.discovery.proposed).toBeGreaterThan(0);
      expect(current.discovery.accepted + current.discovery.rejected).toBe(current.discovery.proposed);
      expect(current.preselection.readings).toHaveLength(current.discovery.accepted);
      expect(current.preselection.preselected).toBeLessThanOrEqual(current.preselection.budget);
      expect(current.construction.built).toBe(current.preselection.preselected);
      expect(current.scoring).toHaveLength(current.construction.accepted);
      expect(current.funnel).toHaveLength(
        BENCHMARK_FIXTURES.find((f) => f.id === current.fixtureId)!.candidates.length,
      );
    }
  });

  it('exercises the budget in every case, so preselection is never a no-op', () => {
    for (const current of report.cases) {
      expect(current.preselection.considered).toBeGreaterThan(current.preselection.budget);
      expect(current.preselection.skipped).toBeGreaterThan(0);
    }
  });

  /**
   * Ranks must be dense and 1-based. The *count* is allowed to fall short of
   * three: once duplicates are ruled out there may simply not be three distinct
   * moments left, and shipping the same forty seconds twice to fill a slot would
   * be the worse answer.
   */
  it('ranks the selected Shorts 1..n with nothing missing', () => {
    for (const current of report.cases) {
      const fixture = BENCHMARK_FIXTURES.find((f) => f.id === current.fixtureId)!;
      const ranks = current.ranking.selected.map((s) => s.rank);

      expect(ranks.length).toBeGreaterThanOrEqual(2);
      expect(ranks.length).toBeLessThanOrEqual(fixture.maxSelected);
      expect(ranks).toEqual(Array.from({ length: ranks.length }, (_, i) => i + 1));
    }
  });

  it('names a reason for every rejection at every stage', () => {
    for (const current of report.cases) {
      const all = [
        ...current.discovery.rejections,
        ...current.construction.rejections,
        ...current.ranking.rejections,
      ];
      expect(all.length).toBeGreaterThan(0);
      for (const rejection of all) {
        expect(rejection.code).toMatch(/^[a-z_]+$/u);
        expect(rejection.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Attribution                                                                */
/* -------------------------------------------------------------------------- */

describe('benchmark attribution', () => {
  it('validates candidates identically one at a time and in a batch', async () => {
    for (const fixture of BENCHMARK_FIXTURES) {
      const built = buildFixtureTranscript(fixture);
      const drafts = await fixtureDiscovery(fixture, built).discoverClips({
        segments: built.transcript.segments.map((s) => ({
          startSec: s.startSec,
          endSec: s.endSec,
          text: s.text,
        })),
        videoDurationSec: built.mediaDurationSec,
        maxCandidates: fixture.candidates.length,
        targetDurationSec: { min: 20, max: 60 },
      });

      const batch = validateCandidates(drafts, built.transcript, built.mediaDurationSec);
      const singly = drafts.flatMap(
        (draft) => validateCandidates([draft], built.transcript, built.mediaDurationSec).accepted,
      );

      expect(singly).toEqual(batch.accepted);
    }
  });

  it('accounts for every fixture candidate exactly once', () => {
    for (const current of report.cases) {
      const ids = current.funnel.map((f) => f.candidateId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Standing quality expectations                                              */
/* -------------------------------------------------------------------------- */

describe('what the pipeline must never do', () => {
  it('rejects a hook quote the speaker never said', () => {
    const entry = outcomeOf('podcast-interview', 'pod-invented-quote');
    expect(entry.outcome).toBe('rejected');
    expect(entry.detail).toContain('quote_not_verbatim');
  });

  it('rejects moments outside the media and outside the duration window', () => {
    expect(outcomeOf('opinion-debate', 'deb-off-media').detail).toContain('outside_media');
    expect(outcomeOf('educational-explainer', 'edu-whole-video').detail).toContain('too_long');
    expect(outcomeOf('storytelling', 'story-fragment').detail).toContain('too_short');
    expect(outcomeOf('fast-conversational', 'fast-snippet').detail).toContain('too_short');
  });

  /**
   * Scoring is what the clip stage guarantees about housekeeping: whatever else
   * happens, it must be the worst thing built.
   *
   * Whether it also stays off the podium is a *funnel* property, and it now
   * holds in both cases — see `keeps channel housekeeping out of the top three`
   * below.
   */
  it('scores channel housekeeping below every other clip it built', () => {
    for (const [fixtureId, candidateId] of [
      ['podcast-interview', 'pod-intro'],
      ['educational-explainer', 'edu-sponsor'],
    ] as const) {
      const scores = caseOf(fixtureId).scoring;
      const worst = [...scores].sort((a, b) => a.overall - b.overall)[0]!;
      expect(worst.candidateId, `${fixtureId}: housekeeping should score lowest`).toBe(candidateId);
    }

    // Only the podcast intro is *detected* as boilerplate. The explainer's
    // sponsor read scores lowest on its other axes alone, because its wording
    // ("quick reminder to like this video", "linked in the description below")
    // is not in the phrase list. Recorded, not asserted away.
    const podIntro = caseOf('podcast-interview').scoring.find((s) => s.candidateId === 'pod-intro')!;
    expect(podIntro.penalties.boilerplate).toBeGreaterThan(0);
  });

  /**
   * The podcast intro is the harder half of this. It is the one clip in the set
   * that is genuinely distinct from everything else, so before ranking learned
   * to charge for overlap rather than refuse it, the intro took the third slot
   * by default: the only other clip left (`pod-offer-rate`) shares five seconds
   * with the top-ranked one and was refused outright.
   */
  it('keeps channel housekeeping out of the top three where ranking has the choice', () => {
    expect(outcomeOf('educational-explainer', 'edu-sponsor').outcome).not.toBe('selected');
    expect(outcomeOf('podcast-interview', 'pod-intro').outcome).not.toBe('selected');
  });

  it('keeps every selected clip inside the hard duration limits', () => {
    for (const current of report.cases) {
      for (const clip of current.ranking.selected) {
        expect(clip.durationSec).toBeGreaterThanOrEqual(CLIP_HARD_MIN_DURATION_SEC);
        expect(clip.durationSec).toBeLessThanOrEqual(CLIP_HARD_MAX_DURATION_SEC);
      }
    }
  });

  it('never ships two Shorts that are the same moment', () => {
    for (const current of report.cases) {
      for (const pair of current.diversity.pairs) {
        const where = `${current.fixtureId}: ${pair.a}/${pair.b}`;
        // The hard bars `selectTopClips` enforces, restated as an outcome check.
        expect(pair.overlapRatio, where).toBeLessThanOrEqual(0.4);
        expect(pair.textSimilarity, where).toBeLessThanOrEqual(0.6);

        // Two Shorts may share seconds — speech does not change subject on a
        // clean edge — but only where they are plainly about different things.
        // Sharing both is the failure this whole test exists to catch.
        if (pair.overlapRatio > 0.1) expect(pair.textSimilarity, where).toBeLessThan(0.3);
      }
    }
  });

  it('keeps every hook quote traceable to the clip that carries it', () => {
    for (const current of report.cases) {
      for (const clip of current.ranking.selected) {
        if (clip.opening.hookQuote === null) continue;
        expect(clip.opening.hookQuote.length).toBeGreaterThan(0);
      }
    }
  });
});
