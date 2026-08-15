import { describe, expect, it } from 'vitest';
import { validateClipPlans } from '@/validation/clip-plans';
import type { ClipPlanDraft } from '@/clips/construction';
import { nowIso, EMPTY_CLIP_SIGNALS, type CandidateClipId } from '@/domain';
import { makeClipBoundaries, TRANSCRIPT_ID, VIDEO_ID } from './helpers/fixtures';

const MEDIA_DURATION = 300;

const makeDraft = (overrides: Partial<ClipPlanDraft> = {}): ClipPlanDraft => ({
  candidateClipId: 'cand-1' as CandidateClipId,
  videoId: VIDEO_ID,
  transcriptId: TRANSCRIPT_ID,
  cuts: [{ order: 0, startSec: 10, endSec: 45 }],
  startSec: 10,
  endSec: 45,
  durationSec: 35,
  text: 'We tried it anyway and it worked out in the end for everyone.',
  hookQuote: 'We tried it anyway',
  topic: 'A topic',
  title: 'A title',
  segmentIds: ['seg-0'] as unknown as ClipPlanDraft['segmentIds'],
  boundaries: makeClipBoundaries(),
  speech: { wordCount: 40, wordsPerSecond: 2.5, maxGapSec: 0 },
  signals: EMPTY_CLIP_SIGNALS,
  semantic: null,
  createdAt: nowIso(),
  ...overrides,
});

const run = (drafts: ClipPlanDraft[]) => validateClipPlans(drafts, MEDIA_DURATION);

describe('validateClipPlans', () => {
  it('accepts a well-formed plan', () => {
    const { accepted, rejected } = run([makeDraft()]);
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
  });

  it('rejects a plan with no cuts', () => {
    const { rejected } = run([makeDraft({ cuts: [] })]);
    expect(rejected[0]!.code).toBe('no_cuts');
  });

  it('rejects cuts that are not ordered', () => {
    const { rejected } = run([
      makeDraft({
        cuts: [
          { order: 1, startSec: 20, endSec: 30 },
          { order: 0, startSec: 0, endSec: 10 },
        ],
      }),
    ]);
    expect(rejected[0]!.code).toBe('cuts_disordered');
  });

  it('rejects overlapping cuts', () => {
    const { rejected } = run([
      makeDraft({
        cuts: [
          { order: 0, startSec: 0, endSec: 20 },
          { order: 1, startSec: 10, endSec: 30 },
        ],
      }),
    ]);
    expect(rejected[0]!.code).toBe('cuts_disordered');
  });

  it('rejects a cut whose end does not exceed its start', () => {
    const { rejected } = run([makeDraft({ cuts: [{ order: 0, startSec: 10, endSec: 10 }] })]);
    expect(rejected[0]!.code).toBe('cuts_disordered');
  });

  it.each([
    [{ startSec: 30, endSec: 10 }],
    [{ startSec: -5, endSec: 10 }],
    [{ startSec: Number.NaN, endSec: 10 }],
  ])('rejects a draft-level range of %j as invalid_range, independent of its (valid) cuts', (range) => {
    // The cuts stay valid so the ordering check passes; only the draft's own
    // startSec/endSec are broken, isolating the invalid_range branch.
    const { rejected } = run([makeDraft({ ...range })]);
    expect(rejected[0]!.code).toBe('invalid_range');
  });

  it('rejects a plan ending past the media duration', () => {
    const { rejected } = run([
      makeDraft({ startSec: 280, endSec: 340, durationSec: 60, cuts: [{ order: 0, startSec: 280, endSec: 340 }] }),
    ]);
    expect(rejected[0]!.code).toBe('outside_media');
  });

  it('rejects a plan whose stated duration does not match the cuts', () => {
    const { rejected } = run([makeDraft({ durationSec: 999 })]);
    expect(rejected[0]!.code).toBe('duration_mismatch');
  });

  it('rejects a plan shorter than the hard minimum', () => {
    const { rejected } = run([
      makeDraft({ startSec: 10, endSec: 20, durationSec: 10, cuts: [{ order: 0, startSec: 10, endSec: 20 }] }),
    ]);
    expect(rejected[0]!.code).toBe('too_short');
  });

  it('rejects a plan longer than the hard maximum', () => {
    const { rejected } = run([
      makeDraft({ startSec: 0, endSec: 60, durationSec: 60, cuts: [{ order: 0, startSec: 0, endSec: 60 }] }),
    ]);
    expect(rejected[0]!.code).toBe('too_long');
  });

  it('rejects a plan with no transcript text', () => {
    const { rejected } = run([makeDraft({ text: '   ' })]);
    expect(rejected[0]!.code).toBe('no_transcript_text');
  });

  it('rejects a plan with no covered segments', () => {
    const { rejected } = run([makeDraft({ segmentIds: [] })]);
    expect(rejected[0]!.code).toBe('no_transcript_text');
  });

  /* -- The verbatim guard --------------------------------------------------- */

  it('accepts a plan whose hookQuote is verbatim in its text', () => {
    const { accepted } = run([makeDraft({ hookQuote: 'it worked out in the end' })]);
    expect(accepted).toHaveLength(1);
  });

  it('accepts a plan with a null hookQuote', () => {
    const { accepted } = run([makeDraft({ hookQuote: null })]);
    expect(accepted).toHaveLength(1);
  });

  it('rejects a plan whose hookQuote was not actually said', () => {
    const { rejected } = run([makeDraft({ hookQuote: 'something the speaker never said' })]);
    expect(rejected[0]!.code).toBe('quote_not_verbatim');
  });

  it('never repairs an invalid plan into an accepted one', () => {
    const { accepted, rejected } = run([
      makeDraft({ hookQuote: 'a fabricated quote' }),
      makeDraft({ candidateClipId: 'cand-2' as CandidateClipId, cuts: [] }),
    ]);
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.code)).toEqual(['quote_not_verbatim', 'no_cuts']);
  });

  it('keeps a good plan alongside a rejected one', () => {
    const { accepted, rejected } = run([
      makeDraft(),
      makeDraft({ candidateClipId: 'cand-2' as CandidateClipId, hookQuote: 'fabricated line' }),
    ]);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});
