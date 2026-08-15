import { describe, expect, it } from 'vitest';
import { normaliseTranscriptDraft, normaliseWhitespace } from '@/validation/transcript';
import type { TranscriptionDraft, TranscriptSegmentDraft } from '@/ai/types';

const draft = (segments: TranscriptSegmentDraft[]): TranscriptionDraft => ({
  language: 'en',
  model: 'test-model',
  segments,
});

const ok: TranscriptSegmentDraft[] = [
  { startSec: 0, endSec: 4, text: 'We tried it anyway.' },
  { startSec: 4, endSec: 9, text: 'It worked.' },
];

describe('normaliseWhitespace', () => {
  it('collapses runs and trims, leaving words untouched', () => {
    expect(normaliseWhitespace('  We   tried\nit\tanyway.  ')).toBe('We tried it anyway.');
  });

  it('does not change casing or punctuation', () => {
    expect(normaliseWhitespace('It WORKED, really!')).toBe('It WORKED, really!');
  });
});

describe('normaliseTranscriptDraft', () => {
  it('accepts a well-formed transcript', () => {
    const result = normaliseTranscriptDraft(draft(ok), 10);

    expect(result.segments).toHaveLength(2);
    expect(result.language).toBe('en');
    expect(result.model).toBe('test-model');
    expect(result.segments[0]!.text).toBe('We tried it anyway.');
    expect(result.notes).toEqual([]);
  });

  it('preserves the spoken words exactly', () => {
    const result = normaliseTranscriptDraft(
      draft([{ startSec: 0, endSec: 4, text: "  it ain't   over, really!  " }]),
      10,
    );

    expect(result.segments[0]!.text).toBe("it ain't over, really!");
  });

  it('reorders segments that arrive out of sequence', () => {
    const result = normaliseTranscriptDraft(draft([ok[1]!, ok[0]!]), 10);

    expect(result.segments.map((s) => s.startSec)).toEqual([0, 4]);
    expect(result.notes).toContain('segments reordered by start time');
  });

  it('drops an empty segment but keeps the rest', () => {
    const result = normaliseTranscriptDraft(
      draft([ok[0]!, { startSec: 4, endSec: 5, text: '   ' }, { startSec: 5, endSec: 9, text: 'It worked.' }]),
      10,
    );

    expect(result.segments).toHaveLength(2);
    expect(result.notes.some((n) => n.includes('no text'))).toBe(true);
  });

  it('clamps a small overshoot past the media duration', () => {
    const result = normaliseTranscriptDraft(draft([{ startSec: 0, endSec: 10.4, text: 'Hi.' }]), 10);

    expect(result.segments[0]!.endSec).toBe(10);
    expect(result.notes.some((n) => n.includes('clamped'))).toBe(true);
  });

  it('normalises confidence into 0..1', () => {
    const result = normaliseTranscriptDraft(
      draft([{ ...ok[0]!, confidence: 1.4 }, { ...ok[1]!, confidence: -3 }]),
      10,
    );

    expect(result.segments[0]!.confidence).toBe(1);
    expect(result.segments[1]!.confidence).toBe(0);
  });

  it('reports a missing confidence as null rather than inventing one', () => {
    expect(normaliseTranscriptDraft(draft(ok), 10).segments[0]!.confidence).toBeNull();
  });

  it.each([
    [[{ startSec: -1, endSec: 4, text: 'a' }], 'negative start'],
    [[{ startSec: 5, endSec: 5, text: 'a' }], 'end equal to start'],
    [[{ startSec: 5, endSec: 2, text: 'a' }], 'end before start'],
    [[{ startSec: Number.NaN, endSec: 4, text: 'a' }], 'non-numeric timestamp'],
    [[{ startSec: 0, endSec: 60, text: 'a' }], 'end far beyond the media'],
    [[{ startSec: 40, endSec: 45, text: 'a' }], 'start beyond the media'],
  ])('rejects %#: %s', (segments) => {
    expect(() => normaliseTranscriptDraft(draft(segments as TranscriptSegmentDraft[]), 10)).toThrowError(
      expect.objectContaining({ kind: 'processing', code: 'invalid_transcript_segment' }),
    );
  });

  it('rejects segments that overlap beyond the tolerance', () => {
    const overlapping = [
      { startSec: 0, endSec: 6, text: 'first' },
      { startSec: 2, endSec: 9, text: 'second' },
    ];

    expect(() => normaliseTranscriptDraft(draft(overlapping), 10)).toThrowError(/overlapping/);
  });

  it('tolerates a fractional overlap at a segment boundary', () => {
    const nearlyTouching = [
      { startSec: 0, endSec: 4, text: 'first' },
      { startSec: 3.9, endSec: 9, text: 'second' },
    ];

    expect(normaliseTranscriptDraft(draft(nearlyTouching), 10).segments).toHaveLength(2);
  });

  it('rejects a transcript with no usable speech', () => {
    expect(() => normaliseTranscriptDraft(draft([{ startSec: 0, endSec: 4, text: '  ' }]), 10)).toThrowError(
      expect.objectContaining({ code: 'empty_transcript' }),
    );
  });

  it('rejects validation without a media duration', () => {
    expect(() => normaliseTranscriptDraft(draft(ok), 0)).toThrowError(
      expect.objectContaining({ code: 'invalid_media_duration' }),
    );
  });
});

describe('word timings', () => {
  const withWords = (words: { text: string; startSec: number; endSec: number }[]) =>
    draft([{ startSec: 0, endSec: 4, text: 'We tried it anyway.', words }]);

  it('keeps valid words in ascending order', () => {
    const result = normaliseTranscriptDraft(
      withWords([
        { text: 'tried', startSec: 1, endSec: 2 },
        { text: 'We', startSec: 0, endSec: 1 },
      ]),
      10,
    );

    expect(result.segments[0]!.words?.map((w) => w.text)).toEqual(['We', 'tried']);
  });

  it('drops unusable words instead of failing the segment', () => {
    const result = normaliseTranscriptDraft(
      withWords([
        { text: 'We', startSec: 0, endSec: 1 },
        { text: 'bad', startSec: 3, endSec: 2 },
        { text: '', startSec: 1, endSec: 2 },
      ]),
      10,
    );

    expect(result.segments[0]!.words).toHaveLength(1);
    expect(result.notes.some((n) => n.includes('word timing'))).toBe(true);
  });

  it('reports null when the provider supplied no words', () => {
    expect(normaliseTranscriptDraft(draft(ok), 10).segments[0]!.words).toBeNull();
  });

  it('reports null when every word was unusable', () => {
    const result = normaliseTranscriptDraft(withWords([{ text: 'x', startSec: -5, endSec: -1 }]), 10);
    expect(result.segments[0]!.words).toBeNull();
  });
});
