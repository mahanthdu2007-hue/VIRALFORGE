import { describe, expect, it } from 'vitest';
import {
  assessCandidate,
  candidateDurationFit,
  isNearDuplicateCandidate,
  partitionNearDuplicates,
  preselectCandidates,
  rankCandidates,
  NEUTRAL_CONFIDENCE,
} from '@/clips/preselection';
import { boundCandidates } from '@/pipeline/analysis';
import {
  nowIso,
  EMPTY_CLIP_SIGNALS,
  CANDIDATE_MAX_DURATION_SEC,
  SHORT_MIN_DURATION_SEC,
  CLIP_HARD_MIN_DURATION_SEC,
  type CandidateClip,
  type CandidateClipId,
  type ClipSignals,
} from '@/domain';
import { TRANSCRIPT_ID, VIDEO_ID } from './helpers/fixtures';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const makeCandidate = (id: string, overrides: Partial<CandidateClip> = {}): CandidateClip => ({
  id: id as CandidateClipId,
  videoId: VIDEO_ID,
  transcriptId: TRANSCRIPT_ID,
  segmentIds: [],
  startSec: 0,
  endSec: 35,
  text: 'We tried it anyway. It worked out in the end.',
  hookQuote: null,
  topic: null,
  reason: 'A moment.',
  signals: EMPTY_CLIP_SIGNALS,
  confidence: 0.5,
  score: null,
  createdAt: nowIso(),
  ...overrides,
});

/** Channel housekeeping: complete sentences, clean edges, nothing in it. */
const BOILERPLATE_TEXT =
  'Hey guys, welcome back to the channel. Before we get started, don’t forget to subscribe ' +
  'and hit the like button. Link in the description below. In today’s video we have a lot to ' +
  'cover, so let’s get into it.';

/** A hook, a middle, and a resolution in the closing line. */
const STRONG_TEXT =
  'Why did the launch nearly fail? We had three weeks of runway and a build nobody could ' +
  'reproduce. Everyone told us to delay it. Turns out the fix was one line in the config. ' +
  'We ended up shipping on the Friday, and that changed how we test everything.';

/**
 * The same moment discovery found again with different edges: it enters one
 * sentence later and runs one sentence longer, so it says almost the same thing.
 */
const STRONG_TEXT_ALT =
  'We had three weeks of runway and a build nobody could reproduce. Everyone told us to delay ' +
  'it. Turns out the fix was one line in the config. We ended up shipping on the Friday, and ' +
  'that changed how we test everything.';

/** Ordinary, competent speech with no particular hook or landing. */
const PLAIN_TEXT =
  'The team met on Tuesday to go over the numbers for the quarter. We looked at the ' +
  'spreadsheet together and agreed on what to do next about the reporting cadence.';

const boilerplateSignals: ClipSignals = {
  ...EMPTY_CLIP_SIGNALS,
  // Discovery genuinely reads an intro this way: it opens strongly and stands
  // alone. That is exactly why confidence alone cannot be trusted here.
  strongOpening: true,
  standalone: 0.9,
};

const strongSignals: ClipSignals = {
  ...EMPTY_CLIP_SIGNALS,
  strongOpening: true,
  questionAnswered: true,
  story: true,
  payoff: true,
  emotionalIntensity: 0.6,
  informationDensity: 0.7,
  standalone: 0.7,
};

const ids = (candidates: readonly CandidateClip[]): string[] => candidates.map((c) => c.id);

/* -------------------------------------------------------------------------- */

describe('assessCandidate', () => {
  it('scores channel boilerplate far below a moment that lands', () => {
    const boilerplate = assessCandidate(
      makeCandidate('boiler', { text: BOILERPLATE_TEXT, signals: boilerplateSignals, confidence: 0.95 }),
    );
    const strong = assessCandidate(
      makeCandidate('strong', { text: STRONG_TEXT, signals: strongSignals, confidence: 0.4 }),
    );

    expect(boilerplate.signals.boilerplate).toBeGreaterThan(0.5);
    expect(strong.signals.boilerplate).toBe(0);
    expect(strong.textPromise).toBeGreaterThan(boilerplate.textPromise);
    // And the blend keeps that verdict, despite the confidence gap running the
    // other way by more than half the scale.
    expect(strong.promise).toBeGreaterThan(boilerplate.promise);
  });

  it('marks down an opening that starts mid-thought', () => {
    const clean = assessCandidate(makeCandidate('a', { text: 'The fix was one line. We shipped it.' }));
    const midThought = assessCandidate(
      makeCandidate('b', { text: 'And so they told us the same thing again. We shipped it.' }),
    );

    expect(midThought.signals.opening).toBeLessThan(clean.signals.opening);
    expect(midThought.signals.contextDependency).toBeGreaterThan(0);
  });

  it('marks down an ending that trails off', () => {
    const landed = assessCandidate(makeCandidate('a', { text: 'We shipped it on the Friday.' }));
    const dangling = assessCandidate(makeCandidate('b', { text: 'We shipped it on the Friday and' }));

    expect(dangling.signals.ending).toBeLessThan(landed.signals.ending);
  });

  it('rewards a payoff in the closing lines over one in the setup', () => {
    const lands = assessCandidate(
      makeCandidate('a', { text: 'We had no runway. Nobody believed it. In the end it worked.' }),
    );
    const setsUp = assessCandidate(
      makeCandidate('b', { text: 'In the end it worked. We had no runway. Nobody believed it.' }),
    );

    expect(lands.signals.payoff).toBeGreaterThan(setsUp.signals.payoff);
  });

  it('counts filler against a candidate', () => {
    const clean = assessCandidate(makeCandidate('a', { text: 'We shipped it on the Friday.' }));
    const padded = assessCandidate(
      makeCandidate('b', { text: 'Um, so, you know, we basically, um, kind of shipped it, I mean.' }),
    );

    expect(padded.signals.filler).toBeGreaterThan(clean.signals.filler);
    expect(padded.textPromise).toBeLessThan(clean.textPromise);
  });

  it('treats a missing confidence as neutral rather than as zero', () => {
    const unknown = assessCandidate(makeCandidate('a', { confidence: null }));
    const stated = assessCandidate(makeCandidate('b', { confidence: NEUTRAL_CONFIDENCE }));

    expect(unknown.confidence).toBe(NEUTRAL_CONFIDENCE);
    expect(unknown.promise).toBe(stated.promise);
  });

  it('honours a confidenceWeight of 1 as confidence-only ordering', () => {
    const weak = assessCandidate(
      makeCandidate('a', { text: BOILERPLATE_TEXT, confidence: 0.9 }),
      { confidenceWeight: 1 },
    );

    expect(weak.promise).toBe(0.9);
  });
});

describe('candidateDurationFit', () => {
  it('gives full marks across the whole discovery window above the Short minimum', () => {
    expect(candidateDurationFit(SHORT_MIN_DURATION_SEC)).toBe(1);
    expect(candidateDurationFit(45)).toBe(1);
    expect(candidateDurationFit(CANDIDATE_MAX_DURATION_SEC)).toBe(1);
  });

  it('marks down a span too short to build a Short from, without writing it off', () => {
    expect(candidateDurationFit(CLIP_HARD_MIN_DURATION_SEC)).toBe(0.5);
    expect(candidateDurationFit(22)).toBeGreaterThan(0.5);
    expect(candidateDurationFit(22)).toBeLessThan(1);
  });

  it('marks down a span longer than one moment', () => {
    expect(candidateDurationFit(90)).toBeLessThan(1);
    expect(candidateDurationFit(CANDIDATE_MAX_DURATION_SEC * 2)).toBe(0);
  });
});

describe('preselectCandidates', () => {
  it('excludes a high-confidence boilerplate candidate in favour of weaker-confidence content', () => {
    const boilerplate = makeCandidate('boiler', {
      startSec: 0,
      endSec: 35,
      text: BOILERPLATE_TEXT,
      signals: boilerplateSignals,
      confidence: 0.98,
    });
    const strong = makeCandidate('strong', {
      startSec: 100,
      endSec: 135,
      text: STRONG_TEXT,
      signals: strongSignals,
      confidence: 0.35,
    });

    const chosen = preselectCandidates([boilerplate, strong], 1);

    expect(ids(chosen)).toEqual(['strong']);
  });

  it('keeps a lower-confidence strong candidate ahead of several plain, confident ones', () => {
    const plain = [0, 1, 2, 3].map((i) =>
      makeCandidate(`plain-${i}`, {
        startSec: i * 100,
        endSec: i * 100 + 35,
        text: PLAIN_TEXT,
        confidence: 0.9,
      }),
    );
    const strong = makeCandidate('strong', {
      startSec: 500,
      endSec: 535,
      text: STRONG_TEXT,
      signals: strongSignals,
      confidence: 0.45,
    });

    const chosen = preselectCandidates([...plain, strong], 2);

    expect(ids(chosen)).toContain('strong');
    expect(chosen).toHaveLength(2);
  });

  it('never filters out the strongest candidates', () => {
    const strong = [0, 1, 2].map((i) =>
      makeCandidate(`strong-${i}`, {
        startSec: i * 100,
        endSec: i * 100 + 35,
        text: STRONG_TEXT,
        signals: strongSignals,
        confidence: 0.5,
      }),
    );
    const weak = [0, 1, 2, 3, 4].map((i) =>
      makeCandidate(`weak-${i}`, {
        startSec: 1000 + i * 100,
        endSec: 1000 + i * 100 + 35,
        text: BOILERPLATE_TEXT,
        signals: boilerplateSignals,
        confidence: 0.99,
      }),
    );

    const chosen = preselectCandidates([...weak, ...strong], 3);

    expect(ids(chosen)).toEqual(['strong-0', 'strong-1', 'strong-2']);
  });

  it('reserves part of the budget for the best-reading candidates, whatever confidence says', () => {
    const confident = Array.from({ length: 12 }, (_, i) =>
      makeCandidate(`plain-${String(i).padStart(2, '0')}`, {
        startSec: i * 100,
        endSec: i * 100 + 35,
        text: PLAIN_TEXT,
        confidence: 1,
      }),
    );
    const unsure = ['strong-a', 'strong-b'].map((id, i) =>
      makeCandidate(id, {
        startSec: 5000 + i * 100,
        endSec: 5000 + i * 100 + 35,
        text: STRONG_TEXT,
        signals: strongSignals,
        confidence: 0.05,
      }),
    );

    // Six slots, a third of them reserved on the text reading alone.
    const chosen = ids(preselectCandidates([...confident, ...unsure], 6));
    expect(chosen).toContain('strong-a');
    expect(chosen).toContain('strong-b');

    // Without the reserve, a confidence gap that wide does outvote the text —
    // which is precisely why the reserve exists.
    const blendOnly = ids(preselectCandidates([...confident, ...unsure], 6, { meritReserveShare: 0 }));
    expect(blendOnly).not.toContain('strong-a');
  });

  it('respects the build limit exactly', () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate(`c-${i}`, {
        startSec: i * 100,
        endSec: i * 100 + 35,
        confidence: (i % 10) / 10,
      }),
    );

    for (const limit of [0, 1, 5, 12, 19]) {
      expect(preselectCandidates(candidates, limit)).toHaveLength(limit);
    }
  });

  it('preserves a candidate set already inside the limit, weak entries included', () => {
    const candidates = [
      makeCandidate('boiler', { text: BOILERPLATE_TEXT, signals: boilerplateSignals, confidence: 0.9 }),
      makeCandidate('plain', { startSec: 100, endSec: 135, text: PLAIN_TEXT, confidence: 0.2 }),
      makeCandidate('fragment', { startSec: 200, endSec: 218, text: 'and then we', confidence: 0.1 }),
    ];

    expect(preselectCandidates(candidates, 3)).toEqual(candidates);
    expect(preselectCandidates(candidates, 12)).toEqual(candidates);
    // Same object, untouched: a small run is never made smaller.
    expect(preselectCandidates(candidates, 12)).toBe(candidates);
  });

  it('returns the bounded set in timeline order', () => {
    const candidates = [
      makeCandidate('late', { startSec: 900, endSec: 935, text: STRONG_TEXT, signals: strongSignals }),
      makeCandidate('early', { startSec: 10, endSec: 45, text: STRONG_TEXT, signals: strongSignals }),
      makeCandidate('middle', { startSec: 400, endSec: 435, text: STRONG_TEXT, signals: strongSignals }),
      makeCandidate('weak', { startSec: 600, endSec: 635, text: BOILERPLATE_TEXT, confidence: 0.99 }),
    ];

    expect(ids(preselectCandidates(candidates, 3))).toEqual(['early', 'middle', 'late']);
  });

  it('is deterministic and independent of the order candidates arrive in', () => {
    const candidates = Array.from({ length: 15 }, (_, i) =>
      makeCandidate(`c-${String(i).padStart(2, '0')}`, {
        startSec: i * 60,
        endSec: i * 60 + 35,
        text: i % 3 === 0 ? STRONG_TEXT : i % 3 === 1 ? PLAIN_TEXT : BOILERPLATE_TEXT,
        confidence: ((i * 7) % 10) / 10,
      }),
    );

    const first = ids(preselectCandidates(candidates, 6));

    expect(ids(preselectCandidates(candidates, 6))).toEqual(first);
    expect(ids(preselectCandidates([...candidates].reverse(), 6))).toEqual(first);
    expect(ids(preselectCandidates([...candidates].sort((a, b) => a.id.localeCompare(b.id)), 6))).toEqual(first);
  });

  it('breaks exact ties on the earlier candidate, then on id', () => {
    // Identical text, identical confidence: only position and id separate them.
    const tied = ['c', 'a', 'b'].map((id, index) =>
      makeCandidate(id, { startSec: index === 0 ? 0 : 100, endSec: index === 0 ? 35 : 135 }),
    );

    const ranked = rankCandidates(tied).map((entry) => entry.candidate.id);

    expect(ranked).toEqual(['c', 'a', 'b']);
  });
});

/* -------------------------------------------------------------------------- */
/* Duplicates                                                                 */
/* -------------------------------------------------------------------------- */

/** The same forty seconds, entered a sentence apart. */
const nearDuplicatePair = (
  overrides: { readonly first?: Partial<CandidateClip>; readonly second?: Partial<CandidateClip> } = {},
): readonly [CandidateClip, CandidateClip] => [
  makeCandidate('moment', {
    startSec: 100,
    endSec: 135,
    text: STRONG_TEXT,
    topic: 'The launch',
    signals: strongSignals,
    confidence: 0.6,
    ...overrides.first,
  }),
  makeCandidate('moment-alt', {
    startSec: 108,
    endSec: 143,
    text: STRONG_TEXT_ALT,
    topic: 'The launch',
    signals: strongSignals,
    confidence: 0.6,
    ...overrides.second,
  }),
];

/** Distinct moments, far apart, sharing nothing but the language they are in. */
const distinctCandidates = (): readonly CandidateClip[] => [
  makeCandidate('distinct-plain', { startSec: 400, endSec: 435, text: PLAIN_TEXT, confidence: 0.7 }),
  makeCandidate('distinct-boiler', {
    startSec: 700,
    endSec: 735,
    text: BOILERPLATE_TEXT,
    signals: boilerplateSignals,
    confidence: 0.8,
  }),
];

describe('isNearDuplicateCandidate', () => {
  it('reads two edges of one moment as the same moment', () => {
    const [a, b] = nearDuplicatePair();
    expect(isNearDuplicateCandidate(a, b)).toBe(true);
    // Symmetric: which one is asked about cannot change the answer.
    expect(isNearDuplicateCandidate(b, a)).toBe(true);
  });

  it('needs both a shared span and shared words, not either alone', () => {
    // Overlapping heavily, but about different things.
    const [overlapping] = nearDuplicatePair();
    const otherSubject = makeCandidate('other', {
      startSec: 105,
      endSec: 140,
      text: PLAIN_TEXT,
      topic: 'The quarter',
    });
    expect(isNearDuplicateCandidate(overlapping, otherSubject)).toBe(false);

    // The same words, but two different parts of the video.
    const early = makeCandidate('early', { startSec: 0, endSec: 35, text: STRONG_TEXT });
    const late = makeCandidate('late', { startSec: 600, endSec: 635, text: STRONG_TEXT_ALT });
    expect(isNearDuplicateCandidate(early, late)).toBe(false);
  });

  it('does not read two adjacent moments as one', () => {
    const [first] = nearDuplicatePair();
    const next = makeCandidate('next', { startSec: 136, endSec: 171, text: PLAIN_TEXT });

    expect(isNearDuplicateCandidate(first, next)).toBe(false);
  });

  it('lowers the bar when discovery gave both spans the same topic', () => {
    // A pair that clears the related bars but not the unrelated ones.
    const a = makeCandidate('a', {
      startSec: 100,
      endSec: 135,
      topic: 'Hiring',
      text: 'We hired nine support agents in a single quarter, and months later the roles vanished.',
    });
    const b = makeCandidate('b', {
      startSec: 118,
      endSec: 153,
      topic: 'Hiring',
      text: 'Months later the support agents we hired saw the roles vanished, and nobody was wrong.',
    });

    expect(isNearDuplicateCandidate(a, b)).toBe(true);
    expect(isNearDuplicateCandidate({ ...a, topic: null }, { ...b, topic: 'Hiring' })).toBe(false);
  });
});

describe('partitionNearDuplicates', () => {
  it('keeps the stronger of a near-duplicate pair, whichever way round it is', () => {
    for (const [strongerId, pair] of [
      ['moment', nearDuplicatePair({ second: { confidence: 0.2 } })],
      ['moment-alt', nearDuplicatePair({ first: { confidence: 0.05 } })],
    ] as const) {
      const partition = partitionNearDuplicates(pair.map((c) => assessCandidate(c)));

      expect(partition.representatives.map((r) => r.candidate.id)).toEqual([strongerId]);
      expect(partition.duplicates.map((d) => d.reading.candidate.id)).toEqual([
        strongerId === 'moment' ? 'moment-alt' : 'moment',
      ]);
      expect(partition.duplicates[0]!.duplicateOf).toBe(strongerId);
    }
  });

  it('keeps a duplicate whose text reads clearly better than what it repeats', () => {
    // Confidence says the trailing-off copy is the moment; the text says
    // otherwise, by more than the override margin. Both are kept, because
    // being near another candidate must not cost a stronger reading its build.
    const pair = nearDuplicatePair({
      first: { confidence: 1, text: `${STRONG_TEXT_ALT} And so we` },
      second: { confidence: 0 },
    });

    const partition = partitionNearDuplicates(pair.map((c) => assessCandidate(c)));
    const [weakText, strongText] = pair.map((c) => assessCandidate(c));

    expect(strongText!.textPromise - weakText!.textPromise).toBeGreaterThan(0.1);
    expect(partition.representatives).toHaveLength(2);
    expect(partition.duplicates).toEqual([]);
  });

  it('leaves every distinct candidate a representative', () => {
    const candidates = [...distinctCandidates(), nearDuplicatePair()[0]!];
    const partition = partitionNearDuplicates(candidates.map((c) => assessCandidate(c)));

    expect(partition.representatives).toHaveLength(3);
    expect(partition.duplicates).toEqual([]);
  });

  it('does the nothing it is asked to when duplicate detection is switched off', () => {
    const readings = nearDuplicatePair().map((c) => assessCandidate(c));

    expect(partitionNearDuplicates(readings, null).representatives).toHaveLength(2);
    expect(partitionNearDuplicates(readings, null).duplicates).toEqual([]);
  });
});

describe('preselectCandidates and near-duplicates', () => {
  it('spends the budget on a second moment rather than on the same one twice', () => {
    const candidates = [...nearDuplicatePair(), ...distinctCandidates()];

    const chosen = ids(preselectCandidates(candidates, 2));

    expect(chosen).toContain('moment');
    expect(chosen).not.toContain('moment-alt');
    expect(chosen).toHaveLength(2);

    // Which is exactly what the budget used to be spent on.
    const before = ids(preselectCandidates(candidates, 2, { duplicates: null }));
    expect(before).toEqual(['moment', 'moment-alt']);
  });

  it('keeps the strongest candidate when it is the one with a copy', () => {
    const candidates = [
      ...nearDuplicatePair({ second: { confidence: 0.1 } }),
      ...distinctCandidates(),
      makeCandidate('plain-late', { startSec: 1000, endSec: 1035, text: PLAIN_TEXT, confidence: 0.75 }),
    ];

    const chosen = ids(preselectCandidates(candidates, 3));

    expect(chosen).toContain('moment');
    expect(chosen).not.toContain('moment-alt');
  });

  it('builds every distinct candidate when they all fit the budget', () => {
    const candidates = [
      nearDuplicatePair()[0]!,
      ...distinctCandidates(),
      makeCandidate('distinct-strong', {
        startSec: 1000,
        endSec: 1035,
        text: STRONG_TEXT,
        signals: strongSignals,
        confidence: 0.5,
      }),
      makeCandidate('distinct-weak', { startSec: 1400, endSec: 1435, text: PLAIN_TEXT, confidence: 0.1 }),
    ];

    expect(ids(preselectCandidates(candidates, 4))).toEqual([
      'moment',
      'distinct-plain',
      'distinct-boiler',
      'distinct-strong',
    ]);
  });

  it('spends the whole budget even when there are not that many distinct moments', () => {
    // Three copies of one moment and one other: nothing is left unbuilt just
    // because the set is repetitive.
    const candidates = [
      ...nearDuplicatePair(),
      makeCandidate('moment-third', {
        startSec: 104,
        endSec: 139,
        text: STRONG_TEXT_ALT,
        topic: 'The launch',
        signals: strongSignals,
        confidence: 0.4,
      }),
      ...distinctCandidates(),
    ];

    for (const limit of [1, 2, 3, 4]) {
      expect(preselectCandidates(candidates, limit)).toHaveLength(limit);
    }

    // The distinct moments come first, the copies only fill what is left over.
    expect(ids(preselectCandidates(candidates, 4))).toEqual([
      'moment',
      'moment-alt',
      'distinct-plain',
      'distinct-boiler',
    ]);
    expect(ids(preselectCandidates(candidates, 3))).toEqual(['moment', 'distinct-plain', 'distinct-boiler']);
  });

  it('leaves a candidate set already inside the limit alone, duplicates included', () => {
    const candidates = [...nearDuplicatePair(), ...distinctCandidates()];

    expect(preselectCandidates(candidates, 4)).toBe(candidates);
    expect(preselectCandidates(candidates, 9)).toBe(candidates);
  });

  it('is deterministic whichever order the duplicates arrive in', () => {
    const candidates = [
      ...nearDuplicatePair(),
      ...distinctCandidates(),
      makeCandidate('moment-third', {
        startSec: 104,
        endSec: 139,
        text: STRONG_TEXT_ALT,
        topic: 'The launch',
        signals: strongSignals,
        confidence: 0.45,
      }),
      makeCandidate('plain-late', { startSec: 1200, endSec: 1235, text: PLAIN_TEXT, confidence: 0.65 }),
    ];

    for (const limit of [2, 3, 4]) {
      const first = ids(preselectCandidates(candidates, limit));

      expect(ids(preselectCandidates(candidates, limit))).toEqual(first);
      expect(ids(preselectCandidates([...candidates].reverse(), limit))).toEqual(first);
      expect(
        ids(preselectCandidates([...candidates].sort((a, b) => a.id.localeCompare(b.id)), limit)),
      ).toEqual(first);
    }
  });

  it('breaks a tie between identical duplicates on the earlier candidate, then on id', () => {
    // Same text, same span, same confidence: only position and id separate them.
    const tied = ['b', 'a'].map((id) =>
      makeCandidate(id, { startSec: 100, endSec: 135, text: STRONG_TEXT, signals: strongSignals }),
    );
    const partition = partitionNearDuplicates(tied.map((c) => assessCandidate(c)));

    expect(partition.representatives.map((r) => r.candidate.id)).toEqual(['a']);
    expect(partition.duplicates.map((d) => d.reading.candidate.id)).toEqual(['b']);
  });
});

describe('boundCandidates', () => {
  it('delegates to preselection while keeping the build limit', () => {
    const candidates = [
      makeCandidate('boiler', { text: BOILERPLATE_TEXT, signals: boilerplateSignals, confidence: 0.99 }),
      makeCandidate('strong', { startSec: 100, endSec: 135, text: STRONG_TEXT, signals: strongSignals, confidence: 0.3 }),
    ];

    expect(ids(boundCandidates(candidates, 1))).toEqual(['strong']);
    expect(boundCandidates(candidates, 5)).toEqual(candidates);
  });
});
