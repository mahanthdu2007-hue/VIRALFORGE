import { describe, expect, it } from 'vitest';
import {
  chooseBoundaries,
  DEFAULT_BOUNDARY_POLICY,
  endAnchors,
  segmentsInRange,
  startAnchors,
  toSpeechTokens,
  type SpeechToken,
} from '@/clips/boundaries';
import { makeTranscript } from './helpers/fixtures';

/** 90s of speech in six 15s segments, no word timings. */
const transcript = makeTranscript([
  { startSec: 0, endSec: 15, text: 'Hello and welcome to the show.' },
  { startSec: 15, endSec: 30, text: 'I thought it would take a year.' },
  { startSec: 30, endSec: 45, text: 'It took us three weeks.' },
  { startSec: 45, endSec: 60, text: 'That surprised everyone on the team.' },
  { startSec: 60, endSec: 75, text: 'The trick was to stop planning.' },
  { startSec: 75, endSec: 90, text: 'We just shipped it on the Friday.' },
]);

const tokens = toSpeechTokens(transcript.segments);

describe('toSpeechTokens', () => {
  it('falls back to segment-level tokens when there are no word timings', () => {
    expect(tokens).toHaveLength(6);
    expect(tokens.every((t) => t.source === 'segment')).toBe(true);
    expect(tokens[0]).toMatchObject({ startSec: 0, endSec: 15, text: 'Hello and welcome to the show.' });
  });

  it('prefers word timings per segment when present', () => {
    const withWords = makeTranscript([{ startSec: 0, endSec: 2, text: 'Hi there.' }]);
    const seg = { ...withWords.segments[0]!, words: [
      { startSec: 0, endSec: 0.5, text: 'Hi' },
      { startSec: 0.5, endSec: 1, text: 'there.' },
    ] };
    const result = toSpeechTokens([seg]);
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.source === 'word')).toBe(true);
  });

  it('clamps a word whose timing falls outside its segment bounds', () => {
    const base = makeTranscript([{ startSec: 0, endSec: 2, text: 'Hi there.' }]);
    const seg = { ...base.segments[0]!, words: [
      { startSec: -5, endSec: 0.5, text: 'Hi' },
      { startSec: 0.5, endSec: 100, text: 'there.' },
    ] };
    const result = toSpeechTokens([seg]);
    expect(result[0]!.startSec).toBe(0);
    expect(result[1]!.endSec).toBe(2);
  });

  it('drops a word whose text is blank after trimming', () => {
    const base = makeTranscript([{ startSec: 0, endSec: 2, text: 'Hi there.' }]);
    const seg = { ...base.segments[0]!, words: [
      { startSec: 0, endSec: 0.5, text: '   ' },
      { startSec: 0.5, endSec: 1, text: 'there.' },
    ] };
    const result = toSpeechTokens([seg]);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe('there.');
  });

  it('sorts tokens by start time across segments', () => {
    const starts = tokens.map((t) => t.startSec);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe('startAnchors / endAnchors', () => {
  it('marks the first token as a sentence start', () => {
    const anchors = startAnchors(tokens);
    expect(anchors[0]!.sentence).toBe(true);
  });

  it('marks a start as a sentence start only when the previous token ended one', () => {
    const anchors = startAnchors(tokens);
    // Segment 1 ends with a period, so segment 2's start is a sentence start.
    expect(anchors[1]!.sentence).toBe(true);
  });

  it('marks ends on sentence-final punctuation', () => {
    const anchors = endAnchors(tokens);
    expect(anchors.every((a) => a.sentence)).toBe(true);
  });

  it('marks an end as not a sentence end when the token has no terminal punctuation', () => {
    const noPunct: SpeechToken[] = [
      { startSec: 0, endSec: 1, text: 'hello', source: 'segment', segmentIndex: 0 },
    ];
    expect(endAnchors(noPunct)[0]!.sentence).toBe(false);
  });
});

describe('chooseBoundaries', () => {
  it('returns the candidate range verbatim when there are no tokens', () => {
    const chosen = chooseBoundaries([], { startSec: 10, endSec: 40 }, 90);
    expect(chosen).toMatchObject({
      startSec: 10,
      endSec: 40,
      startSnap: 'candidate',
      endSnap: 'candidate',
      startsOnSentence: false,
      endsOnSentence: false,
    });
    expect(chosen.notes).toContain('no_speech_tokens');
  });

  it('snaps to sentence boundaries and prefers the 30-40s target window', () => {
    // Candidate roughly 15-60 (45s); a complete-sentence end near 30-40s should win.
    const chosen = chooseBoundaries(tokens, { startSec: 15, endSec: 60 }, 90);
    expect(chosen.startsOnSentence).toBe(true);
    expect(chosen.endsOnSentence).toBe(true);
    const duration = chosen.endSec - chosen.startSec;
    expect(duration).toBeGreaterThanOrEqual(15);
    expect(duration).toBeLessThanOrEqual(55);
  });

  it('never returns a start earlier than startBackSec or later than startForwardSec from the candidate', () => {
    const chosen = chooseBoundaries(tokens, { startSec: 20, endSec: 65 }, 90);
    const policy = DEFAULT_BOUNDARY_POLICY;
    expect(chosen.startSec).toBeGreaterThanOrEqual(20 - policy.startBackSec);
    expect(chosen.startSec).toBeLessThanOrEqual(20 + policy.startForwardSec);
  });

  it('clamps the end to the media duration and notes it', () => {
    // A single long, unpunctuated token: no end anchor falls inside the hard
    // window, so the search falls back to the candidate's own end, which here
    // sits past a media duration shorter than the transcript.
    const custom: SpeechToken[] = [
      { startSec: 0, endSec: 60, text: 'one continuous run of speech with no punctuation at all', source: 'segment', segmentIndex: 0 },
    ];
    const shortMedia = 40;
    const chosen = chooseBoundaries(custom, { startSec: 0, endSec: 60 }, shortMedia);
    expect(chosen.endSec).toBeLessThanOrEqual(shortMedia);
    expect(chosen.notes).toContain('end_clamped_to_media');
  });

  it('prefers a complete-sentence end over a closer incomplete one', () => {
    // Build tokens where an incomplete-sentence end is textually closer to the
    // candidate's end than a complete-sentence end.
    const custom: SpeechToken[] = [
      { startSec: 0, endSec: 5, text: 'This is a full sentence.', source: 'segment', segmentIndex: 0 },
      { startSec: 5, endSec: 20, text: 'this is unfinished', source: 'segment', segmentIndex: 1 },
      { startSec: 20, endSec: 35, text: 'and now it is complete.', source: 'segment', segmentIndex: 2 },
    ];
    // Candidate end at 20 sits right on the incomplete boundary; hard min is 15s
    // so an end at t=5 (5s duration) is out of range, forcing the search to weigh
    // the incomplete end at 20 against the complete end at 35.
    const chosen = chooseBoundaries(custom, { startSec: 0, endSec: 20 }, 40);
    expect(chosen.endsOnSentence).toBe(true);
    expect(chosen.endSec).toBe(35);
  });

  it('rounds returned boundaries to 3 decimal places', () => {
    const custom: SpeechToken[] = [
      { startSec: 0.123456, endSec: 5.654321, text: 'Hello there today.', source: 'word', segmentIndex: 0 },
    ];
    const chosen = chooseBoundaries(custom, { startSec: 0, endSec: 5.654321 }, 10, {
      ...DEFAULT_BOUNDARY_POLICY,
      hardMinSec: 1,
    });
    expect(chosen.startSec.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3);
    expect(chosen.endSec.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3);
  });
});

describe('segmentsInRange', () => {
  it('returns only segments overlapping the range', () => {
    const segs = segmentsInRange(transcript, { startSec: 20, endSec: 50 });
    expect(segs.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it('returns an empty list for a range covering no segment', () => {
    const segs = segmentsInRange(transcript, { startSec: 1000, endSec: 1010 });
    expect(segs).toEqual([]);
  });
});
