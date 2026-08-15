import { describe, expect, it } from 'vitest';
import { ClipConstruction, chooseHookQuote, fallbackTitle, measureSpeech } from '@/clips/construction';
import { toSpeechTokens } from '@/clips/boundaries';
import type { ClipRefinementCapability, ClipRefinementDraft } from '@/ai/types';
import {
  EMPTY_CLIP_SIGNALS,
  nowIso,
  type CandidateClip,
  type CandidateClipId,
  type ClipSignals,
} from '@/domain';
import { makeTranscript, TRANSCRIPT_ID, VIDEO_ID } from './helpers/fixtures';

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

const makeCandidate = (overrides: Partial<CandidateClip> = {}): CandidateClip => ({
  id: 'cand-1' as CandidateClipId,
  videoId: VIDEO_ID,
  transcriptId: TRANSCRIPT_ID,
  startSec: 15,
  endSec: 60,
  segmentIds: [],
  text: 'I thought it would take a year. It took us three weeks. That surprised everyone on the team.',
  hookQuote: 'I thought it would take a year',
  topic: 'Shipping faster than expected',
  reason: 'Sets up an expectation and breaks it.',
  signals,
  confidence: 0.8,
  score: null,
  createdAt: nowIso(),
  ...overrides,
});

describe('ClipConstruction.construct', () => {
  it('builds a draft with snapped boundaries, verbatim text, and one cut', async () => {
    const builder = new ClipConstruction(transcript, MEDIA_DURATION);
    const draft = await builder.construct(makeCandidate());

    expect(draft.startSec).toBeGreaterThanOrEqual(15 - 6);
    expect(draft.endSec).toBeLessThanOrEqual(MEDIA_DURATION);
    expect(draft.cuts).toEqual([{ order: 0, startSec: draft.startSec, endSec: draft.endSec }]);
    expect(draft.durationSec).toBeCloseTo(draft.endSec - draft.startSec, 3);
    expect(draft.text.length).toBeGreaterThan(0);
    expect(draft.semantic).toBeNull();
  });

  it('falls back to rule-based construction when no refinement capability is configured', async () => {
    const builder = new ClipConstruction(transcript, MEDIA_DURATION);
    const draft = await builder.construct(makeCandidate());

    expect(draft.title).toBe('Shipping faster than expected');
    expect(draft.semantic).toBeNull();
  });

  it('uses a validated refinement when the capability returns good output', async () => {
    const capability: ClipRefinementCapability = {
      refineClip: async () =>
        ({
          title: 'The three-week surprise',
          hookQuote: 'It took us three weeks',
          curiosity: 0.7,
          standalone: 0.6,
          payoff: 0.5,
          contextDependency: 0.1,
        }) satisfies ClipRefinementDraft,
    };
    const builder = new ClipConstruction(transcript, MEDIA_DURATION, { refinement: capability });
    const draft = await builder.construct(makeCandidate());

    expect(draft.title).toBe('The three-week surprise');
    expect(draft.hookQuote).toBe('It took us three weeks');
    expect(draft.semantic).toEqual({ curiosity: 0.7, standalone: 0.6, payoff: 0.5, contextDependency: 0.1 });
  });

  it('falls back to rules when the refinement hookQuote is fabricated', async () => {
    const capability: ClipRefinementCapability = {
      refineClip: async () =>
        ({
          title: 'Fabricated title',
          hookQuote: 'Something the speaker never said',
          curiosity: 0.7,
          standalone: 0.6,
          payoff: 0.5,
          contextDependency: 0.1,
        }) satisfies ClipRefinementDraft,
    };
    const builder = new ClipConstruction(transcript, MEDIA_DURATION, { refinement: capability });
    const draft = await builder.construct(makeCandidate());

    // The whole refinement is discarded, including the title.
    expect(draft.title).not.toBe('Fabricated title');
    expect(draft.semantic).toBeNull();
  });

  it('falls back to rules when the refinement call throws', async () => {
    const capability: ClipRefinementCapability = {
      refineClip: async () => {
        throw new Error('provider unavailable');
      },
    };
    const builder = new ClipConstruction(transcript, MEDIA_DURATION, { refinement: capability });
    const draft = await builder.construct(makeCandidate());

    expect(draft.semantic).toBeNull();
    expect(draft.title.length).toBeGreaterThan(0);
  });

  it('constructAll builds one draft per candidate, in order', async () => {
    const builder = new ClipConstruction(transcript, MEDIA_DURATION);
    const drafts = await builder.constructAll([
      makeCandidate({ id: 'cand-1' as CandidateClipId, startSec: 15, endSec: 60 }),
      makeCandidate({ id: 'cand-2' as CandidateClipId, startSec: 45, endSec: 90 }),
    ]);

    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.candidateClipId).toBe('cand-1');
    expect(drafts[1]!.candidateClipId).toBe('cand-2');
  });
});

describe('chooseHookQuote', () => {
  const text = 'It took us three weeks. That surprised everyone on the team.';

  it('prefers a verified refined quote', () => {
    expect(chooseHookQuote(text, 'It took us three weeks', 'That surprised everyone on the team')).toBe(
      'It took us three weeks',
    );
  });

  it('falls back to the candidate hook when the refined quote is not verbatim', () => {
    expect(chooseHookQuote(text, 'a fabricated line', 'That surprised everyone on the team')).toBe(
      'That surprised everyone on the team',
    );
  });

  it('falls back to the clip’s own first sentence when neither supplied quote verifies', () => {
    expect(chooseHookQuote(text, 'fabricated', 'also fabricated')).toBe('It took us three weeks.');
  });

  it('returns null when even the first sentence cannot be verified (empty text)', () => {
    expect(chooseHookQuote('', null, null)).toBeNull();
  });

  it('rejects a first-sentence fallback longer than the max hook length', () => {
    const longFirst = `${'word '.repeat(60).trim()}.`;
    expect(chooseHookQuote(longFirst, null, null)).toBeNull();
  });
});

describe('fallbackTitle', () => {
  it('uses the candidate topic when present', () => {
    expect(fallbackTitle({ topic: 'A great topic' }, 12)).toBe('A great topic');
  });

  it('truncates a topic longer than 80 characters', () => {
    const longTopic = 'x'.repeat(100);
    const title = fallbackTitle({ topic: longTopic }, 0);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to a formatted timecode when there is no topic', () => {
    expect(fallbackTitle({ topic: null }, 65)).toBe('Moment at 01:05');
  });

  it('falls back to a timecode when the topic is blank', () => {
    expect(fallbackTitle({ topic: '   ' }, 5)).toBe('Moment at 00:05');
  });
});

describe('measureSpeech', () => {
  const tokens = toSpeechTokens(transcript.segments);

  it('measures word count and pace inside the given range', () => {
    const stats = measureSpeech(tokens, { startSec: 15, endSec: 30 });
    expect(stats.wordCount).toBeGreaterThan(0);
    expect(stats.wordsPerSecond).toBeGreaterThan(0);
  });

  it('measures the largest gap between consecutive tokens', () => {
    const stats = measureSpeech(tokens, { startSec: 0, endSec: 90 });
    // Segments are contiguous, so there should be no meaningful gap.
    expect(stats.maxGapSec).toBe(0);
  });

  it('returns zero stats for a range with no tokens inside it', () => {
    const stats = measureSpeech(tokens, { startSec: 1000, endSec: 1010 });
    expect(stats.wordCount).toBe(0);
    expect(stats.wordsPerSecond).toBe(0);
  });
});
