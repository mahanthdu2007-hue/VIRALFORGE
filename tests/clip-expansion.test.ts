import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPANSION_POLICY,
  expandCandidateAroundMoment,
  expandCandidateDrafts,
  toSpeechTokens,
} from '@/clips';
import { validateCandidates } from '@/validation/candidates';
import {
  CANDIDATE_MAX_DURATION_SEC,
  CANDIDATE_MIN_DURATION_SEC,
  EMPTY_CLIP_SIGNALS,
  textInRange,
  transcriptText,
  type Transcript,
  type TranscriptSegment,
  type TranscriptWord,
} from '@/domain';
import type { CandidateClipDraft } from '@/ai/types';
import { makeTranscript } from './helpers/fixtures';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * A transcript with word timings, so expansion sees the same granularity the
 * real Parakeet output gives it.
 */
function makeTimedTranscript(
  segments: readonly { startSec: number; endSec: number; text: string }[],
): Transcript {
  const base = makeTranscript(segments);
  return {
    ...base,
    segments: base.segments.map(
      (segment): TranscriptSegment => ({ ...segment, words: spreadWords(segment) }),
    ),
  };
}

/** Distribute a segment's words evenly across its span. */
function spreadWords(segment: TranscriptSegment): readonly TranscriptWord[] {
  const words = segment.text.split(/\s+/u).filter(Boolean);
  const step = (segment.endSec - segment.startSec) / Math.max(words.length, 1);
  return words.map((text, index) => ({
    text,
    startSec: round3(segment.startSec + index * step),
    endSec: round3(segment.startSec + (index + 1) * step),
  }));
}

/** Distinct, punctuated sentences so every segment is one complete thought. */
const SENTENCE_SHAPES = [
  (n: number) => `The team measured throughput on run ${n} and wrote the number down.`,
  (n: number) => `Nobody expected the queue to drain in ${n} minutes flat.`,
  (n: number) => `We rebuilt the indexer ${n} times before it held under load.`,
  (n: number) => `That decision cost us ${n} weeks and taught us where the limit was.`,
  (n: number) => `Our smallest customer found the bug ${n} days after launch.`,
] as const;

/** `count` five-second sentences starting at zero. */
function makeSpeech(count: number, secondsEach = 5): { startSec: number; endSec: number; text: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    startSec: index * secondsEach,
    endSec: (index + 1) * secondsEach,
    text: SENTENCE_SHAPES[index % SENTENCE_SHAPES.length]!(index),
  }));
}

/** 24 sentences, one every five seconds, covering 0–120s. */
const transcript = makeTimedTranscript(makeSpeech(24));
const tokens = toSpeechTokens(transcript.segments);
const MEDIA_DURATION = 120;

const expand = (startSec: number, endSec: number, mediaDurationSec = MEDIA_DURATION) =>
  expandCandidateAroundMoment(tokens, { startSec, endSec }, mediaDurationSec);

const durationOf = (range: { startSec: number; endSec: number }) => range.endSec - range.startSec;

/* -------------------------------------------------------------------------- */

describe('expandCandidateAroundMoment', () => {
  it('turns a 15s discovery into a 30–40s window', () => {
    const range = expand(40, 55);

    expect(range.expanded).toBe(true);
    expect(durationOf(range)).toBeGreaterThanOrEqual(30);
    expect(durationOf(range)).toBeLessThanOrEqual(40);
  });

  it('expands every reported length from the real 41:39 run', () => {
    // The twelve moments Nemotron returned, all 11–16s, all rejected as too
    // short. Lengths preserved; positions moved into this fixture's timeline.
    const lengths = [15.2, 15.6, 13.8, 15.1, 15.7, 15.6, 11.3, 15.5, 15.7, 15.3, 15.7, 15.5];

    for (const [index, length] of lengths.entries()) {
      const startSec = 30 + index * 4;
      const range = expand(startSec, startSec + length);

      expect(range.expanded).toBe(true);
      expect(durationOf(range)).toBeGreaterThanOrEqual(30);
      expect(durationOf(range)).toBeLessThanOrEqual(40);
    }
  });

  it('keeps the discovered moment completely inside the expanded window', () => {
    const range = expand(40, 55);

    expect(range.startSec).toBeLessThanOrEqual(40);
    expect(range.endSec).toBeGreaterThanOrEqual(55);
    expect(range.moment).toEqual({ startSec: 40, endSec: 55 });
  });

  it('prefers boundaries that start and end a sentence', () => {
    const range = expand(40, 55);

    // Every segment here is one sentence, so a sentence boundary is a multiple
    // of five; a mid-sentence cut would not be.
    expect(range.startSec % 5).toBe(0);
    expect(range.endSec % 5).toBe(0);
    expect(range.notes).toEqual([]);
  });

  it('leaves a candidate that is already long enough untouched', () => {
    const range = expand(20, 45);

    expect(range.expanded).toBe(false);
    expect(range).toMatchObject({ startSec: 20, endSec: 45, notes: ['already_long_enough'] });
  });

  it('balances the expansion when both sides have context', () => {
    const range = expand(40, 55);

    const leadIn = 40 - range.startSec;
    const tailOut = range.endSec - 55;
    expect(Math.abs(leadIn - tailOut)).toBeLessThanOrEqual(5);
  });

  /* -- Edges --------------------------------------------------------------- */

  it('expands forward when the moment sits at the start of the video', () => {
    const range = expand(2, 14);

    expect(range.startSec).toBeGreaterThanOrEqual(0);
    expect(40 - range.endSec).toBeLessThan(40);
    // Almost nothing is available behind it, so the runtime has to come forward.
    expect(2 - range.startSec).toBeLessThanOrEqual(2);
    expect(range.endSec - 14).toBeGreaterThan(15);
    expect(durationOf(range)).toBeGreaterThanOrEqual(30);
  });

  it('expands backward when the moment sits at the end of the video', () => {
    const range = expand(104, 118);

    expect(range.endSec).toBeLessThanOrEqual(MEDIA_DURATION);
    expect(104 - range.startSec).toBeGreaterThan(10);
    expect(durationOf(range)).toBeGreaterThanOrEqual(30);
  });

  it('never runs past the media duration', () => {
    for (const start of [0, 10, 50, 100, 104]) {
      const range = expand(start, Math.min(start + 14, MEDIA_DURATION));
      expect(range.startSec).toBeGreaterThanOrEqual(0);
      expect(range.endSec).toBeLessThanOrEqual(MEDIA_DURATION);
    }
  });

  it('never exceeds the hard candidate maximum', () => {
    for (const start of [0, 20, 40, 60, 80]) {
      const range = expand(start, start + 12);
      expect(durationOf(range)).toBeLessThanOrEqual(CANDIDATE_MAX_DURATION_SEC);
    }
  });

  it('avoids expanding across a long silence when the other side is usable', () => {
    // Speech stops at 60s and does not resume until 72s.
    const gapped = makeTimedTranscript([
      ...makeSpeech(12),
      ...makeSpeech(12).map((s) => ({ ...s, startSec: s.startSec + 72, endSec: s.endSec + 72 })),
    ]);
    const gappedTokens = toSpeechTokens(gapped.segments);

    const range = expandCandidateAroundMoment(gappedTokens, { startSec: 40, endSec: 55 }, 132);

    expect(range.expanded).toBe(true);
    expect(range.endSec).toBeLessThanOrEqual(60);
    expect(range.startSec).toBeLessThan(40);
  });

  it('avoids opening the clip on channel housekeeping', () => {
    // The four sentences before the moment are a greeting and a sponsor read.
    const withIntro = makeTimedTranscript(
      makeSpeech(24).map((segment, index) =>
        index >= 4 && index < 8
          ? { ...segment, text: 'Hey guys welcome back to the channel, and thanks to todays sponsor.' }
          : segment,
      ),
    );

    const range = expandCandidateAroundMoment(
      toSpeechTokens(withIntro.segments),
      { startSec: 40, endSec: 55 },
      MEDIA_DURATION,
    );

    expect(range.expanded).toBe(true);
    expect(range.startSec).toBeGreaterThanOrEqual(40 - 0.5);
    expect(range.endSec - 55).toBeGreaterThan(14);
  });

  it('returns the moment untouched when no legal expansion exists', () => {
    const tiny = makeTimedTranscript(makeSpeech(4, 4)); // 16s of speech in total
    const range = expandCandidateAroundMoment(toSpeechTokens(tiny.segments), { startSec: 2, endSec: 14 }, 16);

    expect(range.expanded).toBe(false);
    expect(range).toMatchObject({ startSec: 2, endSec: 14, notes: ['no_usable_expansion'] });
  });

  it('is deterministic for identical input', () => {
    expect(expand(40, 55)).toEqual(expand(40, 55));
    expect(expandCandidateDrafts([draftAt(40, 55)], transcript, MEDIA_DURATION)).toEqual(
      expandCandidateDrafts([draftAt(40, 55)], transcript, MEDIA_DURATION),
    );
  });

  it('reads its duration target from the product constants', () => {
    expect(DEFAULT_EXPANSION_POLICY.minDurationSec).toBe(CANDIDATE_MIN_DURATION_SEC);
    expect(DEFAULT_EXPANSION_POLICY.maxDurationSec).toBe(CANDIDATE_MAX_DURATION_SEC);
    expect(DEFAULT_EXPANSION_POLICY.targetMinSec).toBe(30);
    expect(DEFAULT_EXPANSION_POLICY.targetMaxSec).toBe(40);
    expect(DEFAULT_EXPANSION_POLICY.idealSec).toBe(35);
  });
});

/* -------------------------------------------------------------------------- */
/* Through validation                                                         */
/* -------------------------------------------------------------------------- */

const draftAt = (startSec: number, endSec: number, hookQuote: string | null = null): CandidateClipDraft => ({
  startSec,
  endSec,
  hookQuote,
  topic: 'Throughput',
  reason: 'States a measurement and then says what it cost.',
  signals: { ...EMPTY_CLIP_SIGNALS, strongOpening: true, standalone: 0.8 },
  confidence: 0.7,
});

describe('expansion through candidate validation', () => {
  it('lets a 15s discovery survive the duration rule it used to fail', () => {
    const before = validateCandidates([draftAt(40, 55)], transcript, MEDIA_DURATION);
    expect(before.rejected[0]!.code).toBe('too_short');

    const expanded = expandCandidateDrafts([draftAt(40, 55)], transcript, MEDIA_DURATION);
    const after = validateCandidates(
      expanded.map((e) => e.draft),
      transcript,
      MEDIA_DURATION,
    );

    expect(after.rejected).toEqual([]);
    expect(after.accepted).toHaveLength(1);
  });

  it('adds no words the transcript does not contain', () => {
    const expanded = expandCandidateDrafts([draftAt(40, 55)], transcript, MEDIA_DURATION)[0]!;
    const text = textInRange(transcript, expanded.draft);

    expect(text.length).toBeGreaterThan(0);
    expect(transcriptText(transcript)).toContain(text);
  });

  it('keeps a verbatim hook quote verifiable after expansion', () => {
    const hookQuote = transcript.segments[8]!.text; // the moment's opening sentence
    const expanded = expandCandidateDrafts([draftAt(40, 55, hookQuote)], transcript, MEDIA_DURATION);

    const { accepted, rejected } = validateCandidates(
      expanded.map((e) => e.draft),
      transcript,
      MEDIA_DURATION,
    );

    expect(rejected).toEqual([]);
    expect(accepted[0]!.hookQuote).toBe(hookQuote);
  });

  it('still rejects a moment that cannot be expanded into a usable window', () => {
    const tiny = makeTimedTranscript(makeSpeech(4, 4));
    const expanded = expandCandidateDrafts([draftAt(2, 14)], tiny, 16);

    const { accepted, rejected } = validateCandidates(
      expanded.map((e) => e.draft),
      tiny,
      16,
    );

    expect(accepted).toEqual([]);
    expect(rejected[0]!.code).toBe('too_short');
  });

  it('carries the real 41:39 discovery ranges through validation', () => {
    // A 41:39 timeline at the same sentence cadence as the real run.
    const long = makeTimedTranscript(makeSpeech(499));
    const mediaDurationSec = 2499;

    const moments: readonly [number, number][] = [
      [96.4, 111.6],
      [128.16, 143.76],
      [240.56, 254.4],
      [272.16, 287.28],
      [428, 443.68],
      [572.08, 587.68],
      [588.4, 599.68],
      [680.08, 695.6],
      [840.08, 855.76],
      [2132.32, 2147.6],
      [2276.16, 2291.84],
      [2464.16, 2479.68],
    ];

    const drafts = moments.map(([startSec, endSec]) => draftAt(startSec, endSec));
    const expanded = expandCandidateDrafts(drafts, long, mediaDurationSec);

    for (const [index, entry] of expanded.entries()) {
      const [startSec, endSec] = moments[index]!;
      expect(entry.range.expanded).toBe(true);
      expect(entry.draft.startSec).toBeLessThanOrEqual(startSec);
      expect(entry.draft.endSec).toBeGreaterThanOrEqual(endSec);

      const duration = durationOf(entry.draft);
      expect(duration).toBeGreaterThanOrEqual(30);
      expect(duration).toBeLessThanOrEqual(40);
    }

    const { accepted, rejected } = validateCandidates(
      expanded.map((e) => e.draft),
      long,
      mediaDurationSec,
    );

    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(12);
  });
});
