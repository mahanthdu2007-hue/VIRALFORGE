/**
 * Clip quality and diversity.
 *
 * Everything here runs on synthetic transcripts written to isolate one failure
 * each — a greeting, a fragment, a restatement, an overlap — and on the real
 * construction, scoring and selection code. No provider is configured anywhere
 * in this file, so it also stands as the proof that the rules alone are safe:
 * every judgement below is reached with `semantic: null`.
 */

import { describe, expect, it } from 'vitest';
import { ClipConstruction, type ClipPlanDraft } from '@/clips/construction';
import { scoreClip, type ScoringInput } from '@/clips/scoring';
import { selectTopClips, diversityDiscount, timelineProximity, type ScoredClipPlan } from '@/clips/ranking';
import { analyseText, restatedSentenceRatio, quoteOpensText, splitSentences } from '@/clips/text';
import { validateClipPlans } from '@/validation/clip-plans';
import {
  nowIso,
  EMPTY_CLIP_SIGNALS,
  type CandidateClip,
  type CandidateClipId,
  type ClipScore,
  type ClipSignals,
  type Transcript,
} from '@/domain';
import { makeTranscript, TRANSCRIPT_ID, VIDEO_ID } from './helpers/fixtures';

/* -------------------------------------------------------------------------- */
/* Synthetic material                                                         */
/* -------------------------------------------------------------------------- */

/** Seconds of speech per synthetic sentence, so a ten-line moment runs 40s. */
const SENTENCE_SEC = 4;

/**
 * A moment written to display exactly one property, so a failing assertion
 * points at the measurement rather than at a paragraph of prose.
 */
const MOMENTS = {
  /** Hook, context, development, payoff — the shape a Short is supposed to have. */
  strong: [
    'Nobody warned me about the first year.',
    'I thought the hardest part would be the code.',
    'It was not the code at all.',
    'It was telling six people the same thing every single day.',
    'So we wrote the answer down once and shared it with everyone.',
    'The questions dropped by half inside a week.',
    'Then we did the same thing for the onboarding guide.',
    'That saved another three hours every week.',
    'The lesson is that writing it down beats repeating it.',
    'In the end the document did the work for us.',
  ],

  /** Channel housekeeping: verbatim speech that says nothing. */
  greeting: [
    'Hey guys, welcome back to the channel.',
    'Before we get started, hit the like button.',
    'Um, so, yeah, today we are going to cover a few things.',
    'Anyway, I mean, it is kind of a big topic.',
    'Link in the description if you want the notes.',
    'Okay, so, where was I?',
    'Right, so we should probably start.',
    'You know, it is basically the same as last time.',
    'Like I said, we will get into it.',
    'Anyway, let us jump in properly.',
  ],

  /** One point, made four times. */
  repetitive: [
    'This changed everything about our workflow.',
    'It really changed everything about our workflow.',
    'Our workflow changed completely because of this.',
    'Everything about the workflow changed for us.',
    'So the workflow changed, completely.',
    'It changed everything about how our workflow runs.',
    'That is how much the workflow changed.',
    'The workflow changed and everything changed with it.',
    'Everything changed about our workflow that month.',
    'And our workflow was completely changed.',
  ],

  /** Leans on a referent it never contains, and stops mid-clause. */
  dependent: [
    'And that is exactly what he meant by it.',
    'As I mentioned earlier, they had already tried that one.',
    'So it was the same thing again for them.',
    'That is why she said what she said about it.',
    'Going back to what they told us that morning,',
    'it was them, not us, and that changed it.',
    'Anyway, those were the ones he was talking about.',
    'Which is what made this such a problem for them,',
    'because they had seen it before, and so',
    'and then we',
  ],

  /** A different subject entirely, in the same clean shape as `strong`. */
  bread: [
    'My first sourdough loaf came out like a brick.',
    'The starter was fine and the flour was fine.',
    'The kitchen was the problem: it sat at sixteen degrees.',
    'Yeast does almost nothing at sixteen degrees.',
    'So I proved the next loaf inside the oven with the light on.',
    'That held it at a steady twenty-six degrees all night.',
    'The dough doubled for the first time in a month.',
    'The crumb was open and the crust actually cracked.',
    'The lesson is that temperature matters more than technique.',
    'In the end the oven light fixed what the recipe could not.',
  ],
} as const;

type MomentName = keyof typeof MOMENTS;

/** Lays the moments end to end, one segment per sentence, in a fixed order. */
const LAYOUT: readonly MomentName[] = ['strong', 'greeting', 'repetitive', 'dependent', 'bread'];

/** Start second of each moment in the assembled transcript. */
const MOMENT_START: Record<MomentName, number> = LAYOUT.reduce(
  (starts, name, index) => ({ ...starts, [name]: index * MOMENTS[name].length * SENTENCE_SEC }),
  {} as Record<MomentName, number>,
);

const MOMENT_SEC = MOMENTS.strong.length * SENTENCE_SEC;
const MEDIA_DURATION = LAYOUT.length * MOMENT_SEC;

function buildTranscript(): Transcript {
  const segments: { startSec: number; endSec: number; text: string }[] = [];

  for (const name of LAYOUT) {
    MOMENTS[name].forEach((text, index) => {
      const startSec = MOMENT_START[name] + index * SENTENCE_SEC;
      segments.push({ startSec, endSec: startSec + SENTENCE_SEC, text });
    });
  }

  return makeTranscript(segments);
}

const transcript = buildTranscript();

const speechOf = (name: MomentName): string => MOMENTS[name].join(' ');

/** Neutral signals: nothing here depends on a model's reading of the moment. */
const plainSignals: ClipSignals = { ...EMPTY_CLIP_SIGNALS, standalone: 0.5, informationDensity: 0.5 };

const makeCandidate = (name: MomentName, overrides: Partial<CandidateClip> = {}): CandidateClip => ({
  id: `cand-${name}` as CandidateClipId,
  videoId: VIDEO_ID,
  transcriptId: TRANSCRIPT_ID,
  startSec: MOMENT_START[name],
  endSec: MOMENT_START[name] + MOMENT_SEC,
  segmentIds: [],
  text: speechOf(name),
  hookQuote: MOMENTS[name][0]!,
  topic: name,
  reason: 'Synthetic fixture.',
  signals: plainSignals,
  confidence: 0.8,
  score: null,
  createdAt: nowIso(),
  ...overrides,
});

/** Construction, validation and scoring, with no AI capability configured. */
async function buildAndScore(candidates: readonly CandidateClip[]): Promise<ScoredClipPlan[]> {
  const drafts = await new ClipConstruction(transcript, MEDIA_DURATION).constructAll(candidates);
  const { accepted, rejected } = validateClipPlans(drafts, MEDIA_DURATION);
  expect(rejected).toEqual([]);

  return accepted.map((draft) => ({
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
}

const overallOf = (scored: readonly ScoredClipPlan[], name: MomentName): number =>
  scored.find((s) => s.draft.candidateClipId === `cand-${name}`)!.score.overall;

/* -------------------------------------------------------------------------- */
/* A candidate as a standalone Short                                          */
/* -------------------------------------------------------------------------- */

describe('clip quality — rules only, no provider', () => {
  it('ranks a hook-context-development-payoff moment above every flawed one', async () => {
    const scored = await buildAndScore(LAYOUT.map((name) => makeCandidate(name)));

    for (const weak of ['greeting', 'repetitive', 'dependent'] as const) {
      expect(overallOf(scored, 'strong')).toBeGreaterThan(overallOf(scored, weak));
    }
  });

  it('scores two well-formed moments on different subjects comparably', async () => {
    const scored = await buildAndScore([makeCandidate('strong'), makeCandidate('bread')]);
    // Same shape, different content: neither should be far ahead, or the
    // scorer is reading the subject matter rather than the craft.
    expect(Math.abs(overallOf(scored, 'strong') - overallOf(scored, 'bread'))).toBeLessThan(0.1);
  });

  it('reaches those judgements with no semantic hints at all', async () => {
    const scored = await buildAndScore([makeCandidate('strong'), makeCandidate('greeting')]);
    for (const entry of scored) {
      expect(entry.draft.semantic).toBeNull();
      expect(entry.score.breakdown.aiAssisted).toBe(false);
    }
  });

  it('gives the strong moment the best structure score of the set', async () => {
    const scored = await buildAndScore(LAYOUT.map((name) => makeCandidate(name)));
    const structures = scored.map((s) => ({
      id: s.draft.candidateClipId,
      structure: s.score.breakdown.components.structure,
    }));

    const best = [...structures].sort((a, b) => b.structure - a.structure)[0]!;
    expect(best.id).toBe('cand-strong');
  });
});

/* -------------------------------------------------------------------------- */
/* What gets rejected                                                         */
/* -------------------------------------------------------------------------- */

const baseInput = (overrides: Partial<ScoringInput> = {}): ScoringInput => ({
  text: speechOf('strong'),
  durationSec: 35,
  signals: plainSignals,
  boundaries: { startsOnSentence: true, endsOnSentence: true, startShiftSec: 0 },
  speech: { wordCount: 90, wordsPerSecond: 2.6, maxGapSec: 0.2 },
  hookQuote: MOMENTS.strong[0]!,
  semantic: null,
  ...overrides,
});

describe('rejection of weak openings and endings', () => {
  it('penalises a clip that opens on channel housekeeping', () => {
    const clean = scoreClip(baseInput());
    const greeting = scoreClip(baseInput({ text: `Hey guys, welcome back to the channel. ${speechOf('strong')}` }));

    expect(greeting.breakdown.penalties.boilerplate).toBeGreaterThan(0);
    expect(clean.breakdown.penalties.boilerplate).toBe(0);
    expect(greeting.hook).toBeLessThan(clean.hook);
    expect(greeting.overall).toBeLessThan(clean.overall);
  });

  it('penalises a call to action buried in the middle of an otherwise good clip', () => {
    const clean = scoreClip(baseInput());
    const promo = scoreClip(
      baseInput({
        text: MOMENTS.strong.slice(0, 5).join(' ') +
          ' Link in the description if you want the notes. ' +
          MOMENTS.strong.slice(5).join(' '),
      }),
    );

    expect(promo.breakdown.penalties.boilerplate).toBeGreaterThan(0);
    // It did not open on it, so it keeps its hook.
    expect(promo.hook).toBe(clean.hook);
  });

  it('scores an opening on a conjunction below the same clip opening on a statement', () => {
    const statement = scoreClip(baseInput({ text: 'The document did the work for us. It saved three hours a week.' }));
    const continuation = scoreClip(baseInput({ text: 'And the document did the work for us. It saved three hours a week.' }));

    expect(continuation.breakdown.components.opening).toBeLessThan(statement.breakdown.components.opening);
    expect(continuation.overall).toBeLessThan(statement.overall);
  });

  it('scores a clip trailing off mid-clause far below one that lands', () => {
    const landed = scoreClip(baseInput());
    const trailing = scoreClip(
      baseInput({
        text: `${MOMENTS.strong.slice(0, 8).join(' ')} because they had seen it before, and so and then we`,
        boundaries: { startsOnSentence: true, endsOnSentence: false, startShiftSec: 0 },
      }),
    );

    expect(trailing.breakdown.components.ending).toBeLessThan(0.2);
    expect(trailing.breakdown.components.structure).toBeLessThan(landed.breakdown.components.structure);
  });

  it('treats an incomplete first sentence as a weaker opening than a complete one', () => {
    const complete = analyseText('It was not the code at all. That surprised everyone.');
    const fragment = analyseText('it was not the code at');

    expect(complete.firstSentenceComplete).toBe(true);
    expect(fragment.firstSentenceComplete).toBe(false);
    expect(fragment.endsOnDanglingWord).toBe(true);
  });

  it('penalises a context-dependent fragment on both the penalty and the standalone axis', () => {
    const standalone = scoreClip(baseInput());
    const dependent = scoreClip(baseInput({ text: speechOf('dependent') }));

    expect(dependent.breakdown.penalties.contextDependency).toBeGreaterThan(
      standalone.breakdown.penalties.contextDependency,
    );
    expect(dependent.standalone).toBeLessThan(standalone.standalone);
  });

  it('penalises a clip that restates its one point over and over', () => {
    const varied = scoreClip(baseInput());
    const repeated = scoreClip(baseInput({ text: speechOf('repetitive') }));

    expect(repeated.breakdown.penalties.repetition).toBeGreaterThan(varied.breakdown.penalties.repetition);
    expect(repeated.overall).toBeLessThan(varied.overall);
  });

  it('catches a restatement that shares no three-word run with the original', () => {
    const sentences = [
      'This changed everything about our workflow.',
      'It really changed everything about our workflow.',
    ];
    expect(restatedSentenceRatio(sentences)).toBeGreaterThan(0);

    // Two unrelated claims are not a restatement.
    expect(
      restatedSentenceRatio(['The starter was fine and the flour was fine.', 'The kitchen sat at sixteen degrees.']),
    ).toBe(0);
  });

  it('rewards a payoff in the closing lines over the same words used as a setup', () => {
    const body = MOMENTS.strong.slice(1, 8).join(' ');
    const lands = scoreClip(baseInput({ text: `${body} In the end the document did the work for us.` }));
    const opens = scoreClip(baseInput({ text: `In the end the document did the work for us. ${body}` }));

    expect(lands.breakdown.components.payoff).toBeGreaterThan(opens.breakdown.components.payoff);
  });
});

/* -------------------------------------------------------------------------- */
/* Filler precision — the regression this file exists for                     */
/* -------------------------------------------------------------------------- */

describe('filler measurement', () => {
  it('does not count "right" and "okay" used as ordinary words', () => {
    expect(analyseText('We picked the right approach and it was okay to fail.').fillerRatio).toBe(0);
    expect(analyseText('The right answer was the one nobody liked.').fillerRatio).toBe(0);
  });

  it('does count them as discourse padding at the start of a clause', () => {
    expect(analyseText('Right, so we picked an approach.').fillerRatio).toBeGreaterThan(0);
    expect(analyseText('We shipped it, yeah, on the Friday.').fillerRatio).toBeGreaterThan(0);
    expect(analyseText('Okay so where was I.').fillerRatio).toBeGreaterThan(0);
  });

  it('still counts unambiguous filler wherever it appears', () => {
    expect(analyseText('It was, um, basically the same thing.').fillerRatio).toBeGreaterThan(0);
  });

  it('scores a clip no worse for saying "the right thing" than for not saying it', () => {
    const withRight = scoreClip(baseInput({ text: 'We made the right call. It saved us three hours a week.' }));
    const without = scoreClip(baseInput({ text: 'We made a good call. It saved us three hours a week.' }));

    expect(withRight.breakdown.penalties.filler).toBe(without.breakdown.penalties.filler);
  });
});

/* -------------------------------------------------------------------------- */
/* Hooks                                                                      */
/* -------------------------------------------------------------------------- */

describe('hook credit', () => {
  it('recognises a quote that opens the clip', () => {
    const text = 'It took us three weeks. That surprised everyone on the team.';
    expect(quoteOpensText('It took us three weeks', text)).toBe(true);
    expect(quoteOpensText('That surprised everyone on the team', text)).toBe(false);
  });

  it('credits a hook quote that opens the clip above one lifted from the middle', () => {
    const text = 'It took us three weeks. That surprised everyone on the team, honestly.';
    const opening = scoreClip(baseInput({ text, hookQuote: 'It took us three weeks' }));
    const middle = scoreClip(baseInput({ text, hookQuote: 'That surprised everyone on the team' }));

    expect(opening.hook).toBeGreaterThan(middle.hook);
  });

  it('still credits a middle quote above having no quote at all', () => {
    const text = 'It took us three weeks. That surprised everyone on the team, honestly.';
    const middle = scoreClip(baseInput({ text, hookQuote: 'That surprised everyone on the team' }));
    const none = scoreClip(baseInput({ text, hookQuote: null }));

    expect(middle.hook).toBeGreaterThan(none.hook);
  });

  it('discounts a strong-opening signal once snapping has moved the start away from it', () => {
    const signals: ClipSignals = { ...plainSignals, strongOpening: true };
    const asFound = scoreClip(
      baseInput({ signals, boundaries: { startsOnSentence: true, endsOnSentence: true, startShiftSec: 0 } }),
    );
    const moved = scoreClip(
      baseInput({ signals, boundaries: { startsOnSentence: true, endsOnSentence: true, startShiftSec: -6 } }),
    );

    expect(moved.hook).toBeLessThan(asFound.hook);
  });

  it('treats an absent startShiftSec as no shift, so a hand-built input is unaffected', () => {
    const signals: ClipSignals = { ...plainSignals, strongOpening: true };
    const omitted = scoreClip(baseInput({ signals, boundaries: { startsOnSentence: true, endsOnSentence: true } }));
    const zero = scoreClip(
      baseInput({ signals, boundaries: { startsOnSentence: true, endsOnSentence: true, startShiftSec: 0 } }),
    );

    expect(omitted.hook).toBe(zero.hook);
  });
});

/* -------------------------------------------------------------------------- */
/* Diversity                                                                  */
/* -------------------------------------------------------------------------- */

describe('diversity in selection', () => {
  it('returns one winner for a moment discovered twice with different edges', async () => {
    const scored = await buildAndScore([
      makeCandidate('strong'),
      makeCandidate('strong', {
        id: 'cand-strong-again' as CandidateClipId,
        startSec: MOMENT_START.strong + 6,
        endSec: MOMENT_START.strong + MOMENT_SEC,
      }),
      makeCandidate('bread'),
    ]);

    const { selected, rejected } = selectTopClips(scored);
    const chosen = selected.map((s) => s.draft.candidateClipId);

    expect(chosen).toContain('cand-bread');
    expect(chosen.filter((id) => id.startsWith('cand-strong'))).toHaveLength(1);
    expect(rejected.some((r) => r.code === 'duplicate_moment')).toBe(true);
  });

  /**
   * A winner, a clip from the same stretch of the same topic — related, but
   * under every hard duplicate bar — and something unrelated from elsewhere in
   * the video. Only the discount separates the second and third.
   */
  const WINNER_TEXT = 'We shipped the guide on Friday and the questions stopped for good.';
  const NEIGHBOUR_TEXT = 'Writing that guide once stopped the questions and saved us hours.';
  const UNRELATED_TEXT = 'Sourdough needs a warm kitchen far more than it needs a better recipe.';

  it('prefers a different moment over a near-twin when quality is comparable', () => {
    const winner = makePlan('winner', 0, WINNER_TEXT, 'the guide');
    const neighbour = makePlan('neighbour', 40, NEIGHBOUR_TEXT, 'the guide');
    const other = makePlan('other', 900, UNRELATED_TEXT, 'baking');

    // The neighbour is fractionally ahead of the unrelated clip on raw score.
    const { selected, rejected } = selectTopClips(
      [
        { draft: winner, score: fakeScore(0.9) },
        { draft: neighbour, score: fakeScore(0.71) },
        { draft: other, score: fakeScore(0.7) },
      ],
      { maxSelected: 2 },
    );

    expect(selected.map((s) => s.draft.candidateClipId)).toEqual(['winner', 'other']);
    // It lost on rank, not because it was ruled the same moment.
    expect(rejected).toEqual([
      { candidateClipId: 'neighbour', code: 'beyond_limit', reason: 'Ranked below the top 2.' },
    ]);
  });

  it('never drops a substantially better clip to force variety', () => {
    const winner = makePlan('winner', 0, WINNER_TEXT, 'the guide');
    const neighbour = makePlan('neighbour', 40, NEIGHBOUR_TEXT, 'the guide');
    const other = makePlan('other', 900, UNRELATED_TEXT, 'baking');

    // Same three clips; the neighbour is now ahead by more than the discount
    // can ever be, and variety must not cost us the better Short.
    const { selected } = selectTopClips(
      [
        { draft: winner, score: fakeScore(0.9) },
        { draft: neighbour, score: fakeScore(0.85) },
        { draft: other, score: fakeScore(0.7) },
      ],
      { maxSelected: 2 },
    );

    expect(selected.map((s) => s.draft.candidateClipId)).toEqual(['winner', 'neighbour']);
  });

  it('bounds the discount by maxDiversityDiscount and records what it cost', () => {
    const winner = makePlan('winner', 0, 'We shipped the guide on Friday and the questions stopped for good.');
    const twin = makePlan('twin', 20, 'We shipped the guide on Friday and the questions stopped completely.', 'same');

    const { selected } = selectTopClips([{ draft: winner, score: fakeScore(0.9) }, { draft: twin, score: fakeScore(0.4) }], {
      maxSelected: 2,
      // Overlap and similarity are both under the hard bars here.
      maxOverlapRatio: 1,
      maxTextSimilarity: 1,
    });

    expect(selected[0]!.diversityDiscount).toBe(0);
    expect(selected[1]!.diversityDiscount).toBeGreaterThan(0);
    expect(selected[1]!.diversityDiscount).toBeLessThanOrEqual(0.08);
  });

  it('applies no discount at all when the option is switched off', () => {
    const winner = makePlan('winner', 0, 'We shipped the guide on Friday and the questions stopped for good.');
    const twin = makePlan('twin', 400, 'We shipped the guide on Friday and the questions stopped completely.');

    const { selected } = selectTopClips(
      [{ draft: winner, score: fakeScore(0.9) }, { draft: twin, score: fakeScore(0.4) }],
      { maxDiversityDiscount: 0, maxTextSimilarity: 1 },
    );

    expect(selected.map((s) => s.diversityDiscount)).toEqual([0, 0]);
  });

  it('measures timeline proximity as closeness, not overlap', () => {
    const a = { startSec: 0, endSec: 30 };
    expect(timelineProximity(a, { startSec: 30, endSec: 60 }, 90)).toBe(1);
    expect(timelineProximity(a, { startSec: 75, endSec: 105 }, 90)).toBeCloseTo(0.5);
    expect(timelineProximity(a, { startSec: 500, endSec: 530 }, 90)).toBe(0);
  });

  it('is deterministic: the same plans select the same clips in the same order', async () => {
    const scored = await buildAndScore(LAYOUT.map((name) => makeCandidate(name)));

    const first = selectTopClips(scored).selected.map((s) => [s.draft.candidateClipId, s.rank, s.diversityDiscount]);
    const second = selectTopClips([...scored].reverse()).selected.map((s) => [
      s.draft.candidateClipId,
      s.rank,
      s.diversityDiscount,
    ]);

    expect(first).toEqual(second);
  });

  it('charges nothing for the first pick', () => {
    const only = makePlan('only', 0, 'Sourdough needs a warm kitchen far more than it needs a better recipe.');
    expect(diversityDiscount(only, [], { maxTextSimilarity: 0.6, maxDiversityDiscount: 0.08, nearbySeparationSec: 90 })).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* End to end through the clip stage                                          */
/* -------------------------------------------------------------------------- */

describe('selection over the whole synthetic video', () => {
  it('never spends one of three Shorts on the housekeeping moment', async () => {
    const scored = await buildAndScore(LAYOUT.map((name) => makeCandidate(name)));
    const { selected } = selectTopClips(scored);

    expect(selected).toHaveLength(3);
    expect(selected[0]!.draft.candidateClipId).toBe('cand-strong');
    expect(selected.map((s) => s.draft.candidateClipId)).not.toContain('cand-greeting');
  });

  it('keeps every selected clip verbatim, hook quote included', async () => {
    const scored = await buildAndScore(LAYOUT.map((name) => makeCandidate(name)));
    const { selected } = selectTopClips(scored);

    for (const { draft } of selected) {
      const spoken = splitSentences(draft.text);
      expect(spoken.length).toBeGreaterThan(0);
      if (draft.hookQuote) expect(draft.text).toContain(draft.hookQuote);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Local builders for the ranking tests                                       */
/* -------------------------------------------------------------------------- */

function makePlan(id: string, startSec: number, text: string, topic: string | null = id): ClipPlanDraft {
  return {
    candidateClipId: id as CandidateClipId,
    videoId: VIDEO_ID,
    transcriptId: TRANSCRIPT_ID,
    cuts: [{ order: 0, startSec, endSec: startSec + 35 }],
    startSec,
    endSec: startSec + 35,
    durationSec: 35,
    text,
    hookQuote: null,
    topic,
    title: id,
    segmentIds: [],
    boundaries: {
      startSnap: 'word' as const,
      endSnap: 'word' as const,
      startsOnSentence: true,
      endsOnSentence: true,
      startShiftSec: 0,
      endShiftSec: 0,
      notes: [],
    },
    speech: { wordCount: 90, wordsPerSecond: 2.6, maxGapSec: 0.2 },
    signals: plainSignals,
    semantic: null,
    createdAt: nowIso(),
  };
}

/** A real score with `overall` pinned, so a ranking test states its own gaps. */
const fakeScore = (overall: number): ClipScore => ({ ...scoreClip(baseInput()), overall });
