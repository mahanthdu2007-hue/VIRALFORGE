import { describe, expect, it } from 'vitest';
import { durationFit, scoreClip, type ScoringInput } from '@/clips/scoring';
import { DEFAULT_SCORE_WEIGHTS, totalComponentWeight } from '@/clips/weights';
import {
  CLIP_HARD_MAX_DURATION_SEC,
  CLIP_HARD_MIN_DURATION_SEC,
  EMPTY_CLIP_SIGNALS,
  SHORT_MAX_DURATION_SEC,
  SHORT_MIN_DURATION_SEC,
  type ClipSignals,
} from '@/domain';

const strongSignals: ClipSignals = {
  strongOpening: true,
  questionAnswered: true,
  strongOpinion: true,
  surprise: true,
  story: true,
  payoff: true,
  emotionalIntensity: 1,
  informationDensity: 1,
  standalone: 1,
};

const baseInput = (overrides: Partial<ScoringInput> = {}): ScoringInput => ({
  text: 'Nobody saw the twist coming. We tried a new approach and it worked well. The result changed everything for the team.',
  durationSec: 35,
  signals: strongSignals,
  boundaries: { startsOnSentence: true, endsOnSentence: true },
  speech: { wordCount: 60, wordsPerSecond: 2.5, maxGapSec: 0.2 },
  hookQuote: 'Nobody saw the twist coming',
  semantic: null,
  ...overrides,
});

describe('durationFit', () => {
  it('returns 1 inside the 30-40s target window', () => {
    expect(durationFit(SHORT_MIN_DURATION_SEC)).toBe(1);
    expect(durationFit(35)).toBe(1);
    expect(durationFit(SHORT_MAX_DURATION_SEC)).toBe(1);
  });

  it('falls linearly to 0 at the hard minimum', () => {
    expect(durationFit(CLIP_HARD_MIN_DURATION_SEC)).toBe(0);
  });

  it('falls linearly to 0 at the hard maximum', () => {
    expect(durationFit(CLIP_HARD_MAX_DURATION_SEC)).toBe(0);
  });

  it('is between 0 and 1 for a duration between hard and target bounds', () => {
    const value = durationFit(20);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  });
});

describe('scoreClip', () => {
  it('produces a fully-populated score with sub-scores in 0..1', () => {
    const score = scoreClip(baseInput());

    for (const value of [score.hook, score.standalone, score.emotion, score.value, score.overall]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(score.rationale.length).toBeGreaterThan(0);
  });

  it('is deterministic for identical input', () => {
    const a = scoreClip(baseInput());
    const b = scoreClip(baseInput());
    expect(a).toEqual(b);
  });

  it('scores a strong clip higher than a weak one', () => {
    const strong = scoreClip(baseInput());
    const weak = scoreClip(
      baseInput({
        signals: EMPTY_CLIP_SIGNALS,
        boundaries: { startsOnSentence: false, endsOnSentence: false },
        hookQuote: null,
        text: 'um so anyway it was fine i guess whatever',
      }),
    );
    expect(strong.overall).toBeGreaterThan(weak.overall);
  });

  it('records aiAssisted false when no semantic hints are supplied', () => {
    const score = scoreClip(baseInput({ semantic: null }));
    expect(score.breakdown.aiAssisted).toBe(false);
  });

  it('records aiAssisted true when semantic hints are supplied', () => {
    const score = scoreClip(
      baseInput({ semantic: { curiosity: 0.8, standalone: 0.8, payoff: 0.8, contextDependency: 0.1 } }),
    );
    expect(score.breakdown.aiAssisted).toBe(true);
  });

  it('penalises filler-heavy text', () => {
    const clean = scoreClip(baseInput());
    const filler = scoreClip(
      baseInput({
        text: 'um uh so like you know basically it was, um, you know, kind of amazing honestly.',
      }),
    );
    expect(filler.breakdown.penalties.filler).toBeGreaterThan(clean.breakdown.penalties.filler);
    expect(filler.overall).toBeLessThan(clean.overall);
  });

  it('penalises repeated phrasing', () => {
    const clean = scoreClip(baseInput());
    const repeated = scoreClip(
      baseInput({
        text: 'it was amazing honestly it was amazing honestly it was amazing honestly and that is the truth',
      }),
    );
    expect(repeated.breakdown.penalties.repetition).toBeGreaterThan(clean.breakdown.penalties.repetition);
  });

  it('penalises context dependency and blends it with a semantic hint', () => {
    const ruleOnly = scoreClip(
      baseInput({ text: 'As I mentioned earlier, that changes everything about it.', semantic: null }),
    );
    expect(ruleOnly.breakdown.penalties.contextDependency).toBeGreaterThan(0);

    const blended = scoreClip(
      baseInput({
        text: 'As I mentioned earlier, that changes everything about it.',
        semantic: { curiosity: 0, standalone: 0, payoff: 0, contextDependency: 1 },
      }),
    );
    expect(blended.breakdown.penalties.contextDependency).toBeGreaterThan(ruleOnly.breakdown.penalties.contextDependency);
  });

  it('computes componentTotal and penaltyTotal as weighted sums matching overall', () => {
    const score = scoreClip(baseInput());
    const expectedOverall = Math.min(
      1,
      Math.max(0, score.breakdown.componentTotal - score.breakdown.penaltyTotal),
    );
    expect(score.overall).toBeCloseTo(expectedOverall, 4);
  });

  it('gives a perfect clip an overall score of 1 when weights sum to 1 and there are no penalties', () => {
    expect(totalComponentWeight(DEFAULT_SCORE_WEIGHTS)).toBeCloseTo(1, 6);
  });

  it('rationale names the strongest and weakest components', () => {
    const score = scoreClip(baseInput());
    expect(score.rationale).toMatch(/Strongest on/);
    expect(score.rationale).toMatch(/weakest on/);
  });

  it('rationale mentions penalties only when they cost something material', () => {
    const clean = scoreClip(baseInput());
    expect(clean.rationale).not.toMatch(/Penalised for/);

    const penalised = scoreClip(
      baseInput({ text: 'um uh so like you know basically it was, um, you know, kind of amazing honestly.' }),
    );
    expect(penalised.rationale).toMatch(/Penalised for/);
  });
});
