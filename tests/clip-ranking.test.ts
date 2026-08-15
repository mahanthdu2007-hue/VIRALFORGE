import { describe, expect, it } from 'vitest';
import {
  isSameMoment,
  overlapDiscount,
  overlapRatio,
  selectTopClips,
  type ScoredClipPlan,
} from '@/clips/ranking';
import type { ClipPlanDraft } from '@/clips/construction';
import {
  nowIso,
  EMPTY_CLIP_SIGNALS,
  type CandidateClipId,
  type ClipScore,
} from '@/domain';
import { makeClipBoundaries, makeClipScore, TRANSCRIPT_ID, VIDEO_ID } from './helpers/fixtures';

const makeDraft = (overrides: Partial<ClipPlanDraft> = {}): ClipPlanDraft => ({
  candidateClipId: 'cand-1' as CandidateClipId,
  videoId: VIDEO_ID,
  transcriptId: TRANSCRIPT_ID,
  cuts: [{ order: 0, startSec: 0, endSec: 30 }],
  startSec: 0,
  endSec: 30,
  durationSec: 30,
  text: 'We tried it anyway and it worked out in the end.',
  hookQuote: 'We tried it anyway',
  topic: 'A topic',
  title: 'A title',
  segmentIds: [],
  boundaries: makeClipBoundaries(),
  speech: { wordCount: 40, wordsPerSecond: 2.5, maxGapSec: 0 },
  signals: EMPTY_CLIP_SIGNALS,
  semantic: null,
  createdAt: nowIso(),
  ...overrides,
});

const makeScore = (overall: number): ClipScore => makeClipScore({ overall });

const scored = (draft: ClipPlanDraft, overall: number): ScoredClipPlan => ({ draft, score: makeScore(overall) });

describe('overlapRatio', () => {
  it('returns 0 for non-overlapping ranges', () => {
    expect(overlapRatio({ startSec: 0, endSec: 10 }, { startSec: 20, endSec: 30 })).toBe(0);
  });

  it('returns 1 for identical ranges', () => {
    expect(overlapRatio({ startSec: 0, endSec: 10 }, { startSec: 0, endSec: 10 })).toBe(1);
  });

  it('measures overlap as a share of the shorter range', () => {
    // 5s overlap of a 10s and 20s range; shorter is 10s => 0.5.
    expect(overlapRatio({ startSec: 0, endSec: 10 }, { startSec: 5, endSec: 25 })).toBeCloseTo(0.5);
  });
});

describe('isSameMoment', () => {
  it('treats heavily overlapping ranges as the same moment', () => {
    const a = makeDraft({ startSec: 0, endSec: 30 });
    const b = makeDraft({ startSec: 5, endSec: 35, text: 'Completely different words about something else entirely.' });
    expect(isSameMoment(a, b, 0.25, 0.6)).toBe(true);
  });

  it('treats non-overlapping, dissimilar clips as distinct', () => {
    const a = makeDraft({ startSec: 0, endSec: 30, text: 'We tried it anyway and it worked out in the end.' });
    const b = makeDraft({
      startSec: 200,
      endSec: 230,
      text: 'The weather in Iceland was surprisingly warm this winter season.',
    });
    expect(isSameMoment(a, b, 0.25, 0.6)).toBe(false);
  });

  it('treats non-overlapping clips with highly similar text as the same moment', () => {
    const a = makeDraft({ startSec: 0, endSec: 30, text: 'We tried it anyway and it worked out great honestly.' });
    const b = makeDraft({ startSec: 500, endSec: 530, text: 'We tried it anyway and it worked out great honestly.' });
    expect(isSameMoment(a, b, 0.25, 0.6)).toBe(true);
  });

  it('lowers the similarity bar when topics match', () => {
    const a = makeDraft({
      startSec: 0,
      endSec: 30,
      topic: 'Shared topic',
      text: 'We tried it anyway and it worked out great in the end honestly for everyone involved here.',
    });
    const b = makeDraft({
      startSec: 500,
      endSec: 530,
      topic: 'Shared topic',
      text: 'We tried it anyway and honestly it worked out great for the whole entire team involved.',
    });
    expect(isSameMoment(a, b, 0.25, 0.6)).toBe(true);
  });
});

describe('selectTopClips', () => {
  it('ranks by score descending and assigns 1-based ranks', () => {
    const low = scored(makeDraft({ candidateClipId: 'low' as CandidateClipId, startSec: 0, endSec: 30 }), 0.4);
    const high = scored(
      makeDraft({ candidateClipId: 'high' as CandidateClipId, startSec: 200, endSec: 230, text: 'Totally different unrelated content about baking bread.' }),
      0.9,
    );

    const { selected } = selectTopClips([low, high]);

    expect(selected.map((s) => s.draft.candidateClipId)).toEqual(['high', 'low']);
    expect(selected.map((s) => s.rank)).toEqual([1, 2]);
  });

  it('breaks score ties by earlier start time, then candidate id', () => {
    const a = scored(
      makeDraft({ candidateClipId: 'b-clip' as CandidateClipId, startSec: 100, endSec: 130, text: 'Alpha bravo charlie delta echo foxtrot golf.' }),
      0.7,
    );
    const b = scored(
      makeDraft({ candidateClipId: 'a-clip' as CandidateClipId, startSec: 0, endSec: 30, text: 'Hotel india juliet kilo lima mike november.' }),
      0.7,
    );

    const { selected } = selectTopClips([a, b]);
    expect(selected[0]!.draft.candidateClipId).toBe('a-clip');
  });

  it('rejects a duplicate moment in favor of the higher-scored one', () => {
    const winner = scored(
      makeDraft({ candidateClipId: 'winner' as CandidateClipId, startSec: 0, endSec: 30 }),
      0.9,
    );
    const duplicate = scored(
      makeDraft({ candidateClipId: 'dup' as CandidateClipId, startSec: 2, endSec: 32 }),
      0.6,
    );

    const { selected, rejected } = selectTopClips([winner, duplicate]);

    expect(selected).toHaveLength(1);
    expect(selected[0]!.draft.candidateClipId).toBe('winner');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!).toMatchObject({ candidateClipId: 'dup', code: 'duplicate_moment' });
  });

  it('selects only the top N distinct clips and rejects the rest as beyond_limit', () => {
    const distinctTexts = [
      'Alpha bravo charlie delta echo foxtrot golf hotel.',
      'India juliet kilo lima mike november oscar papa.',
      'Quebec romeo sierra tango uniform victor whiskey.',
      'Xray yankee zulu alpha bravo charlie delta echo.',
    ];
    const entries = distinctTexts.map((text, i) =>
      scored(
        makeDraft({
          candidateClipId: `c${i}` as CandidateClipId,
          startSec: i * 200,
          endSec: i * 200 + 30,
          text,
        }),
        0.9 - i * 0.1,
      ),
    );

    const { selected, rejected } = selectTopClips(entries, { maxSelected: 3 });

    expect(selected).toHaveLength(3);
    expect(selected.map((s) => s.draft.candidateClipId)).toEqual(['c0', 'c1', 'c2']);
    expect(rejected).toEqual([{ candidateClipId: 'c3', code: 'beyond_limit', reason: 'Ranked below the top 3.' }]);
  });

  it('produces the same selection order for the same input every time', () => {
    const entries = [
      scored(makeDraft({ candidateClipId: 'x' as CandidateClipId, startSec: 0, endSec: 30, text: 'Alpha bravo charlie delta.' }), 0.5),
      scored(makeDraft({ candidateClipId: 'y' as CandidateClipId, startSec: 100, endSec: 130, text: 'Echo foxtrot golf hotel.' }), 0.8),
    ];

    const first = selectTopClips(entries).selected.map((s) => s.draft.candidateClipId);
    const second = selectTopClips(entries).selected.map((s) => s.draft.candidateClipId);
    expect(first).toEqual(second);
  });
});

/* -------------------------------------------------------------------------- */
/* Overlapping, but not the same moment                                       */
/* -------------------------------------------------------------------------- */

/**
 * Speech does not change subject on a clean edge, so the sentence that closes
 * one moment routinely opens the next and two genuinely different clips end up
 * sharing a few seconds. Refusing every such pair outright threw the material
 * away and handed the slot to whichever clip happened to touch nothing — which,
 * in a video that opens on housekeeping, is the housekeeping.
 *
 * These cases pin the line that replaced it: a pair that is *mostly* the same
 * seconds, or that says the same thing, is still refused outright; a pair that
 * merely shares an edge is charged a bounded price and then judged on quality.
 */
describe('overlapping candidates in selection', () => {
  /** Three sentences with no content word in common with the others. */
  const HIRING = 'Every candidate spends two hours solving a problem our engineers actually failed to solve.';
  const OFFERS = 'Acceptance climbed from about half to nearly ninety percent within one quarter.';
  const HOUSEKEEPING = 'Please subscribe, ring that notification bell, and follow whatever link sits below.';
  const BAKING = 'Sourdough wants a warm kitchen considerably more than it wants another recipe.';

  const plan = (id: string, startSec: number, endSec: number, text: string, topic: string): ClipPlanDraft =>
    makeDraft({
      candidateClipId: id as CandidateClipId,
      startSec,
      endSec,
      durationSec: endSec - startSec,
      cuts: [{ order: 0, startSec, endSec }],
      text,
      topic,
    });

  it('refuses a clip that is mostly the same seconds, however well it scores', () => {
    // 30 of 35 seconds shared: the same moment cut twice, whatever it says.
    const winner = plan('winner', 0, 35, HIRING, 'Interviews');
    const twin = plan('twin', 5, 40, OFFERS, 'Offers');

    const { selected, rejected } = selectTopClips([scored(winner, 0.7), scored(twin, 0.69)]);

    expect(selected.map((s) => s.draft.candidateClipId)).toEqual(['winner']);
    expect(rejected).toEqual([
      { candidateClipId: 'twin', code: 'duplicate_moment', reason: 'Covers the same moment as the clip ranked 1.' },
    ]);
  });

  it('refuses a modest overlap that also says the same thing', () => {
    // Only a fifth of the span is shared, but the words are the same words:
    // the hard bar is the *worse* of the two readings, not the average.
    const winner = plan('winner', 0, 35, HIRING, 'Interviews');
    const restated = plan('restated', 28, 63, `${HIRING} It really did.`, 'Interviews again');

    const { selected, rejected } = selectTopClips([scored(winner, 0.7), scored(restated, 0.69)]);

    expect(selected.map((s) => s.draft.candidateClipId)).toEqual(['winner']);
    expect(rejected[0]).toMatchObject({ candidateClipId: 'restated', code: 'duplicate_moment' });
  });

  it('ships two clips that share an edge but say different things', () => {
    // Five of 35 seconds — one bridging sentence — and nothing else in common.
    const winner = plan('winner', 0, 35, HIRING, 'Interviews');
    const neighbour = plan('neighbour', 30, 65, OFFERS, 'Offers');

    const { selected } = selectTopClips([scored(winner, 0.7), scored(neighbour, 0.62)], { maxSelected: 2 });

    expect(selected.map((s) => s.draft.candidateClipId)).toEqual(['winner', 'neighbour']);
    expect(selected[1]!.overlapDiscount).toBeGreaterThan(0);
    expect(selected[1]!.overlapDiscount).toBeLessThanOrEqual(0.12);
  });

  /** The podcast case, in miniature: this is the shape that used to go wrong. */
  it('prefers a distinct overlapping clip to a weaker clip that overlaps nothing', () => {
    const winner = plan('winner', 0, 35, HIRING, 'Interviews');
    const neighbour = plan('neighbour', 30, 65, OFFERS, 'Offers');
    const housekeeping = plan('housekeeping', 300, 335, HOUSEKEEPING, 'Show introduction');

    const { selected, rejected } = selectTopClips(
      [scored(winner, 0.7), scored(neighbour, 0.62), scored(housekeeping, 0.58)],
      { maxSelected: 2 },
    );

    expect(selected.map((s) => s.draft.candidateClipId)).toEqual(['winner', 'neighbour']);
    // Overlapping cost it a price, not its place: it lost on rank alone.
    expect(rejected).toEqual([
      { candidateClipId: 'housekeeping', code: 'beyond_limit', reason: 'Ranked below the top 2.' },
    ]);
  });

  it('keeps a substantially better overlapping clip over a distinct weaker one', () => {
    // Nearly a third of the span shared — close to the duplicate bar, so close
    // to the full price — and it still wins, because it is better by more.
    const winner = plan('winner', 0, 35, HIRING, 'Interviews');
    const strong = plan('strong', 24.5, 59.5, OFFERS, 'Offers');
    const distinct = plan('distinct', 400, 435, BAKING, 'Baking');

    const { selected } = selectTopClips([scored(winner, 0.75), scored(strong, 0.7), scored(distinct, 0.6)], {
      maxSelected: 2,
    });

    expect(selected.map((s) => s.draft.candidateClipId)).toEqual(['winner', 'strong']);
  });

  it('reverses that choice when the two are near enough to a tie', () => {
    // Same three clips, same overlap; the only thing that moved is the gap
    // between them, and now the price is worth more than the difference.
    const winner = plan('winner', 0, 35, HIRING, 'Interviews');
    const strong = plan('strong', 24.5, 59.5, OFFERS, 'Offers');
    const distinct = plan('distinct', 400, 435, BAKING, 'Baking');

    const { selected } = selectTopClips([scored(winner, 0.75), scored(strong, 0.63), scored(distinct, 0.6)], {
      maxSelected: 2,
    });

    expect(selected.map((s) => s.draft.candidateClipId)).toEqual(['winner', 'distinct']);
  });

  it('charges nothing at all when three clips are genuinely distinct', () => {
    const entries = [
      scored(plan('a', 0, 35, HIRING, 'Interviews'), 0.7),
      scored(plan('b', 400, 435, OFFERS, 'Offers'), 0.65),
      scored(plan('c', 800, 835, BAKING, 'Baking'), 0.6),
    ];

    const { selected, rejected } = selectTopClips(entries);

    expect(selected.map((s) => s.draft.candidateClipId)).toEqual(['a', 'b', 'c']);
    expect(selected.map((s) => s.overlapDiscount)).toEqual([0, 0, 0]);
    expect(selected.map((s) => s.diversityDiscount)).toEqual([0, 0, 0]);
    expect(rejected).toEqual([]);
  });

  it('leaves the diversity discount to handle clips that overlap nothing', () => {
    // Adjacent but not touching, and on the same topic: no overlap price, and
    // the existing bounded diversity discount does the whole job.
    const winner = plan('winner', 0, 35, HIRING, 'Interviews');
    const nearby = plan('nearby', 40, 75, OFFERS, 'Interviews');

    const { selected } = selectTopClips([scored(winner, 0.7), scored(nearby, 0.6)], { maxSelected: 2 });

    expect(selected[1]!.overlapDiscount).toBe(0);
    expect(selected[1]!.diversityDiscount).toBeGreaterThan(0);
    expect(selected[1]!.diversityDiscount).toBeLessThanOrEqual(0.08);
  });

  it('picks the same clips, ranks and prices from the reversed input', () => {
    const entries = [
      scored(plan('winner', 0, 35, HIRING, 'Interviews'), 0.7),
      scored(plan('neighbour', 30, 65, OFFERS, 'Offers'), 0.62),
      scored(plan('housekeeping', 300, 335, HOUSEKEEPING, 'Show introduction'), 0.58),
      scored(plan('baking', 800, 835, BAKING, 'Baking'), 0.58),
    ];

    const shape = (result: ReturnType<typeof selectTopClips>) => ({
      selected: result.selected.map((s) => [
        s.draft.candidateClipId,
        s.rank,
        s.diversityDiscount,
        s.overlapDiscount,
      ]),
      rejected: result.rejected,
    });

    expect(shape(selectTopClips([...entries].reverse()))).toEqual(shape(selectTopClips(entries)));
  });

  it('never charges more than maxOverlapDiscount, right up to the duplicate bar', () => {
    const winner = plan('winner', 0, 35, HIRING, 'Interviews');
    const policy = {
      maxOverlapRatio: 0.1,
      duplicateOverlapRatio: 0.4,
      maxTextSimilarity: 0.6,
      maxOverlapDiscount: 0.12,
    };

    // Just under the bar, sharing 14 of 35 seconds, and saying the same thing.
    const worst = plan('worst', 21.1, 56.1, `${HIRING} ${OFFERS}`, 'Interviews');

    expect(overlapDiscount(worst, [{ draft: winner }], policy)).toBeLessThanOrEqual(0.12);
    expect(overlapDiscount(worst, [{ draft: winner }], policy)).toBeGreaterThan(0.06);
    // And nothing at all below the price bar, or with no clips chosen yet.
    expect(overlapDiscount(plan('far', 400, 435, OFFERS, 'Offers'), [{ draft: winner }], policy)).toBe(0);
    expect(overlapDiscount(worst, [], policy)).toBe(0);
  });
});
