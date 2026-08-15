import { describe, expect, it } from 'vitest';
import { validateCandidates } from '@/validation/candidates';
import { EMPTY_CLIP_SIGNALS, type ClipSignals } from '@/domain';
import type { CandidateClipDraft } from '@/ai/types';
import { makeTranscript } from './helpers/fixtures';

/** 90 seconds of speech in six 15s segments. */
const transcript = makeTranscript([
  { startSec: 0, endSec: 15, text: 'Hello and welcome to the show.' },
  { startSec: 15, endSec: 30, text: 'I thought it would take a year.' },
  { startSec: 30, endSec: 45, text: 'It took us three weeks.' },
  { startSec: 45, endSec: 60, text: 'That surprised everyone on the team.' },
  { startSec: 60, endSec: 75, text: 'The trick was to stop planning.' },
  { startSec: 75, endSec: 90, text: 'We just shipped it on the Friday.' },
]);

const MEDIA_DURATION = 90;

const signals: ClipSignals = { ...EMPTY_CLIP_SIGNALS, strongOpening: true, standalone: 0.8 };

const makeDraft = (overrides: Partial<CandidateClipDraft> = {}): CandidateClipDraft => ({
  startSec: 15,
  endSec: 60,
  hookQuote: 'I thought it would take a year',
  topic: 'Shipping faster than expected',
  reason: 'Sets up an expectation and immediately breaks it.',
  signals,
  confidence: 0.8,
  ...overrides,
});

const run = (drafts: CandidateClipDraft[]) => validateCandidates(drafts, transcript, MEDIA_DURATION);

describe('validateCandidates', () => {
  it('accepts a well-formed candidate and attaches transcript context', () => {
    const { accepted, rejected } = run([makeDraft()]);

    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);

    const candidate = accepted[0]!;
    expect(candidate.startSec).toBe(15);
    expect(candidate.endSec).toBe(60);
    expect(candidate.text).toContain('It took us three weeks.');
    expect(candidate.segmentIds).toHaveLength(3);
    expect(candidate.hookQuote).toBe('I thought it would take a year');
    expect(candidate.confidence).toBe(0.8);
  });

  it('accepts a candidate with no hook quote at all', () => {
    const { accepted } = run([makeDraft({ hookQuote: null })]);
    expect(accepted[0]!.hookQuote).toBeNull();
  });

  it('keeps the good candidates when one is invalid', () => {
    const { accepted, rejected } = run([
      makeDraft(),
      makeDraft({ startSec: 30, endSec: 75, hookQuote: 'I never said this sentence' }),
    ]);

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.code).toBe('quote_not_verbatim');
  });

  /* -- The verbatim boundary ---------------------------------------------- */

  it('rejects a fabricated quote', () => {
    const { accepted, rejected } = run([makeDraft({ hookQuote: 'I thought it would take a decade' })]);

    expect(accepted).toEqual([]);
    expect(rejected[0]!.code).toBe('quote_not_verbatim');
    expect(rejected[0]!.reason).toContain('altered or invented');
  });

  it('rejects a quote that is real but from outside the candidate window', () => {
    // The greeting is in the transcript, but not inside 15s–60s.
    const { rejected } = run([makeDraft({ hookQuote: 'Hello and welcome to the show' })]);
    expect(rejected[0]!.code).toBe('quote_not_verbatim');
  });

  it('accepts a quote differing only in punctuation and case', () => {
    const { accepted } = run([makeDraft({ hookQuote: 'IT TOOK US THREE WEEKS!!!' })]);
    expect(accepted).toHaveLength(1);
  });

  it('rejects a paraphrase that keeps the meaning', () => {
    const { rejected } = run([makeDraft({ hookQuote: 'It only took three weeks' })]);
    expect(rejected[0]!.code).toBe('quote_not_verbatim');
  });

  /* -- Ranges -------------------------------------------------------------- */

  it.each([
    [{ startSec: 60, endSec: 30 }, 'invalid_range'],
    [{ startSec: -5, endSec: 40 }, 'invalid_range'],
    [{ startSec: Number.NaN, endSec: 40 }, 'invalid_range'],
    [{ startSec: 120, endSec: 160 }, 'outside_media'],
    [{ startSec: 40, endSec: 200 }, 'outside_media'],
    [{ startSec: 15, endSec: 25 }, 'too_short'],
    [{ startSec: 0, endSec: 90 }, 'too_long'],
  ])('rejects %j as %s', (range, code) => {
    const { accepted, rejected } = run([makeDraft({ ...range, hookQuote: null })]);

    expect(accepted).toEqual([]);
    expect(rejected[0]!.code).toBe(code);
  });

  it('clamps a marginal overshoot rather than rejecting it', () => {
    const { accepted } = run([makeDraft({ startSec: 45, endSec: 90.5, hookQuote: null })]);

    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.endSec).toBe(90);
  });

  /* -- Structure ----------------------------------------------------------- */

  it('rejects a candidate with no stated reason', () => {
    expect(run([makeDraft({ reason: '   ' })]).rejected[0]!.code).toBe('missing_reason');
  });

  it('rejects malformed signals', () => {
    const bad = { ...signals, standalone: 4 } as ClipSignals;
    expect(run([makeDraft({ signals: bad })]).rejected[0]!.code).toBe('invalid_signals');

    const missing = { strongOpening: true } as unknown as ClipSignals;
    expect(run([makeDraft({ signals: missing })]).rejected[0]!.code).toBe('invalid_signals');
  });

  it('rejects an out-of-range confidence', () => {
    expect(run([makeDraft({ confidence: 1.5 })]).rejected[0]!.code).toBe('invalid_confidence');
  });

  it('accepts a candidate with no confidence at all', () => {
    const draft = makeDraft();
    delete (draft as { confidence?: number }).confidence;

    const { accepted } = run([draft]);
    expect(accepted[0]!.confidence).toBeNull();
  });

  it('rejects a window that contains no speech', () => {
    const silent = makeTranscript([{ startSec: 0, endSec: 5, text: 'Only a moment of speech.' }]);
    const { rejected } = validateCandidates([makeDraft({ hookQuote: null })], silent, MEDIA_DURATION);

    expect(rejected[0]!.code).toBe('no_transcript_text');
  });

  it('honours custom duration bounds', () => {
    const { accepted } = validateCandidates([makeDraft({ startSec: 15, endSec: 25, hookQuote: null })], transcript, MEDIA_DURATION, {
      minDurationSec: 5,
      maxDurationSec: 20,
    });

    expect(accepted).toHaveLength(1);
  });

  it('never repairs a rejected candidate into an accepted one', () => {
    const { accepted, rejected } = run([
      makeDraft({ hookQuote: 'a quote nobody said' }),
      makeDraft({ startSec: 15, endSec: 16, hookQuote: null }),
    ]);

    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.code)).toEqual(['quote_not_verbatim', 'too_short']);
  });
});
