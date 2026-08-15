import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUBTITLE_OPTIONS,
  planSubtitleLayout,
  subtitlePlanText,
  subtitleText,
  validateSubtitleSegments,
  verifySubtitleFidelity,
  layoutClearsSubject,
  boxWithinFrame,
  estimateTextUnits,
  type ClipCut,
  type SubtitleOptions,
  type SubtitleSegment,
  type SubtitleSourceWord,
  type TranscriptSegment,
  type TranscriptSegmentId,
} from '@/domain';
import {
  buildClipTimeline,
  buildSubtitlePlan,
  chunkWordsIntoCues,
  collectClipWords,
  endsSentence,
  escapeAssText,
  formatAssTime,
  layoutLines,
  mapRangeToClip,
  renderAssDocument,
  subtitlesFilter,
} from '@/subtitles';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

type WordSpec = readonly [text: string, startSec: number, endSec: number];

const sourceWords = (specs: readonly WordSpec[]): SubtitleSourceWord[] =>
  specs.map(([text, startSec, endSec]) => ({
    text,
    startSec,
    endSec,
    sourceSegmentId: 'seg-0' as TranscriptSegmentId,
    timingSource: 'word',
  }));

/** Words with a uniform cadence, so a test can state only the text. */
const evenWords = (text: string, startSec = 0, secondsPerWord = 0.4): SubtitleSourceWord[] =>
  sourceWords(
    text
      .split(' ')
      .map(
        (word, index): WordSpec => [
          word,
          startSec + index * secondsPerWord,
          startSec + (index + 1) * secondsPerWord,
        ],
      ),
  );

const chunk = (
  words: readonly SubtitleSourceWord[],
  overrides: Partial<SubtitleOptions> = {},
  maxCharsPerLine = 40,
): SubtitleSegment[] =>
  chunkWordsIntoCues(words, {
    options: { ...DEFAULT_SUBTITLE_OPTIONS, ...overrides },
    maxCharsPerLine,
    clipDurationSec: 60,
  });

const cut = (startSec: number, endSec: number, order = 0): ClipCut => ({ startSec, endSec, order });

const timedSegment = (
  index: number,
  specs: readonly WordSpec[],
  overrides: Partial<TranscriptSegment> = {},
): TranscriptSegment => ({
  id: `seg-${index}` as TranscriptSegmentId,
  index,
  startSec: specs[0]![1],
  endSec: specs[specs.length - 1]![2],
  text: specs.map(([text]) => text).join(' '),
  confidence: 1,
  speaker: null,
  words: specs.map(([text, startSec, endSec]) => ({ text, startSec, endSec })),
  ...overrides,
});

const plainSegment = (
  index: number,
  startSec: number,
  endSec: number,
  text: string,
): TranscriptSegment => ({
  id: `seg-${index}` as TranscriptSegmentId,
  index,
  startSec,
  endSec,
  text,
  confidence: 1,
  speaker: null,
  words: null,
});

/* -------------------------------------------------------------------------- */
/* Clip timeline                                                              */
/* -------------------------------------------------------------------------- */

describe('clip timeline', () => {
  it('lays cuts end to end and reports the total runtime', () => {
    const timeline = buildClipTimeline([cut(100, 110, 0), cut(200, 205, 1)]);

    expect(timeline.offsets).toEqual([0, 10]);
    expect(timeline.durationSec).toBe(15);
  });

  it('orders cuts by their stated order, not their position in the array', () => {
    const timeline = buildClipTimeline([cut(200, 205, 1), cut(100, 110, 0)]);

    expect(timeline.cuts.map((c) => c.startSec)).toEqual([100, 200]);
    expect(timeline.offsets).toEqual([0, 10]);
  });

  it('maps a source range onto the clip timeline', () => {
    const timeline = buildClipTimeline([cut(100, 110, 0), cut(200, 205, 1)]);

    expect(mapRangeToClip(timeline, { startSec: 102, endSec: 103 })).toEqual({
      startSec: 2,
      endSec: 3,
    });
    expect(mapRangeToClip(timeline, { startSec: 201, endSec: 202 })).toEqual({
      startSec: 11,
      endSec: 12,
    });
  });

  it('drops a range the cuts do not carry', () => {
    const timeline = buildClipTimeline([cut(100, 110, 0)]);

    expect(mapRangeToClip(timeline, { startSec: 150, endSec: 151 })).toBeNull();
  });

  it('clips a range that straddles a cut boundary instead of stretching it', () => {
    const timeline = buildClipTimeline([cut(100, 110, 0)]);

    expect(mapRangeToClip(timeline, { startSec: 109.5, endSec: 111 })).toEqual({
      startSec: 9.5,
      endSec: 10,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Word collection                                                            */
/* -------------------------------------------------------------------------- */

describe('word collection', () => {
  it('takes provider word timings verbatim and rebases them on the clip', () => {
    const timeline = buildClipTimeline([cut(10, 20, 0)]);
    const collected = collectClipWords(
      [timedSegment(0, [['We', 11, 11.3], ['tried', 11.3, 11.8], ['it.', 11.8, 12.2]])],
      timeline,
    );

    expect(collected.words.map((w) => w.text)).toEqual(['We', 'tried', 'it.']);
    expect(collected.words[0]).toMatchObject({ startSec: 1, timingSource: 'word' });
    expect(collected.notes).not.toContain('segment_timing_estimated');
  });

  it('apportions a segment without word timings and marks the estimate', () => {
    const timeline = buildClipTimeline([cut(0, 30, 0)]);
    const collected = collectClipWords([plainSegment(0, 0, 4, 'a extraordinarily long word')], timeline);

    expect(collected.words.map((w) => w.text)).toEqual(['a', 'extraordinarily', 'long', 'word']);
    expect(collected.words.every((w) => w.timingSource === 'segment')).toBe(true);
    expect(collected.notes).toContain('segment_timing_estimated');
    expect(collected.notes).toContain('no_word_timings');

    // Longer tokens get longer, and the last word ends exactly on the segment.
    const durations = collected.words.map((w) => w.endSec - w.startSec);
    expect(durations[1]!).toBeGreaterThan(durations[0]!);
    expect(collected.words[3]!.endSec).toBeCloseTo(4, 6);
  });

  it('drops words the cuts removed rather than shifting them into the clip', () => {
    const timeline = buildClipTimeline([cut(0, 2, 0)]);
    const collected = collectClipWords(
      [timedSegment(0, [['kept', 0.5, 1], ['cut', 5, 5.4]], { startSec: 0.5, endSec: 5.4 })],
      timeline,
    );

    expect(collected.words.map((w) => w.text)).toEqual(['kept']);
  });

  it('notes a clip with no speech instead of failing', () => {
    const timeline = buildClipTimeline([cut(0, 5, 0)]);

    expect(collectClipWords([], timeline).notes).toContain('no_speech_in_clip');
  });
});

/* -------------------------------------------------------------------------- */
/* Chunking                                                                   */
/* -------------------------------------------------------------------------- */

describe('chunking', () => {
  it('reproduces the transcript exactly, punctuation and case included', () => {
    const words = evenWords("Don't rewrite what the SPEAKER said, ever — really.");
    const cues = chunk(words);

    expect(subtitlePlanText(cues)).toBe("Don't rewrite what the SPEAKER said, ever — really.");
    expect(cues.flatMap((cue) => cue.words ?? []).map((w) => w.text)).toEqual(
      words.map((w) => w.text),
    );
  });

  it('breaks on a sentence end', () => {
    const cues = chunk(evenWords('It worked. Nobody expected that'));

    expect(cues.map(subtitleText)).toEqual(['It worked.', 'Nobody expected that']);
  });

  it('does not break on an abbreviation or an initial', () => {
    const cues = chunk(evenWords('Dr. J. Smith arrived'), { maxWordsPerCaption: 10 });

    expect(cues.map(subtitleText)).toEqual(['Dr. J. Smith arrived']);
  });

  it('breaks where the speaker paused', () => {
    const cues = chunk(
      sourceWords([
        ['one', 0, 0.3],
        ['two', 0.3, 0.6],
        // 0.6s of silence: past the 0.45s pause threshold.
        ['three', 1.2, 1.5],
      ]),
      { breakOnSentenceEnd: false },
    );

    expect(cues.map(subtitleText)).toEqual(['one two', 'three']);
  });

  it('breaks on a clause only once the cue has enough words', () => {
    const early = chunk(evenWords('so, this is the part that matters'), {
      breakOnClauseAfterWords: 3,
      maxWordsPerCaption: 8,
    });
    // "so," is one word, under the guard, so the comma is ignored.
    expect(early.map(subtitleText)).toEqual(['so, this is the part that matters']);

    const late = chunk(evenWords('this is the part, and it matters'), {
      breakOnClauseAfterWords: 3,
      maxWordsPerCaption: 8,
    });
    expect(late.map(subtitleText)).toEqual(['this is the part,', 'and it matters']);
  });

  it('honours the word cap', () => {
    const cues = chunk(evenWords('one two three four five six seven eight'), {
      maxWordsPerCaption: 3,
      breakOnClauseAfterWords: 0,
    });

    expect(cues.map(subtitleText)).toEqual(['one two three', 'four five six', 'seven eight']);
  });

  it('honours the duration cap', () => {
    const cues = chunk(evenWords('one two three four five six', 0, 1), {
      maxDurationSec: 2,
      maxWordsPerCaption: 10,
    });

    expect(cues.map(subtitleText)).toEqual(['one two', 'three four', 'five six']);
    for (const cue of cues) expect(cue.endSec - cue.startSec).toBeLessThanOrEqual(2.0001);
  });

  it('never lets a cue outlast the duration cap, even for one long word', () => {
    const cues = chunk(sourceWords([['aaaaaaaa', 0, 9]]), { maxDurationSec: 3 });

    expect(cues).toHaveLength(1);
    expect(cues[0]!.endSec).toBe(3);
    // The word's timing is trimmed with it; the text is untouched.
    expect(cues[0]!.words![0]).toMatchObject({ text: 'aaaaaaaa', endSec: 3 });
  });

  it('holds a fast cue for the minimum readable duration', () => {
    const cues = chunk(sourceWords([['yes.', 0, 0.2]]), { minDurationSec: 0.7 });

    expect(cues[0]!.endSec).toBeCloseTo(0.7, 6);
  });

  it('does not stretch a cue over the one that follows it', () => {
    const cues = chunk(
      sourceWords([
        ['yes.', 0, 0.2],
        ['and.', 0.3, 0.6],
      ]),
      { minDurationSec: 0.7, mergeShortCues: false },
    );

    expect(cues[0]!.endSec).toBeLessThanOrEqual(cues[1]!.startSec);
    expect(validateSubtitleSegments(cues, 60)).toEqual([]);
  });

  it('breaks a cue across lines without splitting a word', () => {
    const cues = chunk(evenWords('alpha bravo charlie delta echo foxtrot'), {}, 14);

    expect(cues[0]!.lines.length).toBeLessThanOrEqual(DEFAULT_SUBTITLE_OPTIONS.maxLines);
    for (const cue of cues) {
      expect(cue.lines.join(' ').split(' ')).toEqual(
        (cue.words ?? []).map((word) => word.text),
      );
    }
  });

  it('starts a new cue rather than a third line', () => {
    const cues = chunk(evenWords('alpha bravo charlie delta echo foxtrot golf'), {
      maxLines: 2,
      maxWordsPerCaption: 10,
      breakOnClauseAfterWords: 0,
    }, 12);

    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) expect(cue.lines.length).toBeLessThanOrEqual(2);
  });

  it('merges an orphaned tail into the cue before it', () => {
    const words = sourceWords([
      ['We', 0, 0.3],
      ['tried', 0.3, 0.7],
      ['it', 0.7, 1],
      ['anyway.', 1, 1.4],
      ['Yeah.', 1.5, 1.7],
    ]);

    expect(chunk(words).map(subtitleText)).toEqual(['We tried it anyway. Yeah.']);
    expect(chunk(words, { mergeShortCues: false }).map(subtitleText)).toEqual([
      'We tried it anyway.',
      'Yeah.',
    ]);
  });

  it('refuses a merge that would break a cap', () => {
    const cues = chunk(
      sourceWords([
        ['one', 0, 0.3],
        ['two', 0.3, 0.6],
        ['three.', 0.6, 0.9],
        ['Yeah.', 1, 1.2],
      ]),
      { maxWordsPerCaption: 3 },
    );

    expect(cues.map(subtitleText)).toEqual(['one two three.', 'Yeah.']);
  });

  it('numbers cues from the configured start index', () => {
    const cues = chunkWordsIntoCues(evenWords('one two. three four.'), {
      options: DEFAULT_SUBTITLE_OPTIONS,
      maxCharsPerLine: 40,
      clipDurationSec: 10,
      startIndex: 7,
    });

    expect(cues.map((cue) => cue.index)).toEqual([7, 8]);
  });

  it('records how the cue was timed', () => {
    const mixed: SubtitleSourceWord[] = [
      { text: 'one', startSec: 0, endSec: 0.3, sourceSegmentId: null, timingSource: 'word' },
      { text: 'two', startSec: 0.3, endSec: 0.6, sourceSegmentId: null, timingSource: 'segment' },
    ];

    expect(chunk(evenWords('one two'))[0]!.timingSource).toBe('word');
    expect(chunk(mixed)[0]!.timingSource).toBe('segment');
  });
});

describe('line layout', () => {
  it('fills greedily and keeps long words whole', () => {
    expect(layoutLines(['aaa', 'bbb', 'ccc'], 8)).toEqual(['aaa bbb', 'ccc']);
    expect(layoutLines(['supercalifragilistic'], 5)).toEqual(['supercalifragilistic']);
  });

  it('breaks wide text earlier than narrow text at the same budget', () => {
    // The bug this guards: a flat per-character budget let a full line of wide
    // glyphs render wider than the whole 1080px frame, clipped at both edges,
    // because libass is told not to wrap.
    const wide = layoutLines('WHAT HAPPENED NEXT WAS'.split(' '), 21);
    const narrow = layoutLines('it is if it is if it'.split(' '), 21);

    expect(wide.length).toBeGreaterThan(1);
    expect(narrow).toEqual(['it is if it is if it']);
  });

  it('keeps every line inside the caption box at the layout it advertises', () => {
    const result = planSubtitleLayout();
    if (!result.ok) throw new Error(`layout failed: ${result.reason}`);
    const layout = result.layout;
    const budgetPx = layout.box.width;

    const lines = layoutLines('WHAT HAPPENED NEXT WAS ENTIRELY'.split(' '), layout.maxCharsPerLine);

    for (const line of lines) {
      expect(estimateTextUnits(line) * layout.fontSizePx).toBeLessThanOrEqual(budgetPx);
    }
  });
});

describe('text width estimation', () => {
  it('ranks glyph classes the way the font does', () => {
    expect(estimateTextUnits('lll')).toBeLessThan(estimateTextUnits('aaa'));
    expect(estimateTextUnits('aaa')).toBeLessThan(estimateTextUnits('AAA'));
    expect(estimateTextUnits('AAA')).toBeLessThan(estimateTextUnits('WWW'));
  });

  it('is additive and deterministic', () => {
    expect(estimateTextUnits('ab')).toBeCloseTo(estimateTextUnits('a') + estimateTextUnits('b'), 10);
    expect(estimateTextUnits('')).toBe(0);
  });
});

describe('sentence detection', () => {
  it.each([
    ['works.', true],
    ['really?', true],
    ['"Stop!"', true],
    ['wait…', true],
    ['Dr.', false],
    ['e.g.', false],
    ['J.', false],
    ['clause,', false],
    ['plain', false],
  ])('%s', (text, expected) => {
    expect(endsSentence(text)).toBe(expected);
  });
});

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

describe('9:16 layout', () => {
  it('keeps the caption block inside the safe area of a 1080x1920 frame', () => {
    const result = planSubtitleLayout();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { layout } = result;
    expect(layout.output).toEqual({ width: 1080, height: 1920 });
    expect(boxWithinFrame(layout.box, layout.output)).toBe(true);
    expect(layout.box.y).toBeGreaterThanOrEqual(layout.safeArea.y);
    expect(layout.box.y + layout.box.height).toBeLessThanOrEqual(
      layout.safeArea.y + layout.safeArea.height,
    );
    // The bottom inset is what keeps captions clear of the player's chrome.
    expect(layout.marginVerticalPx).toBeGreaterThanOrEqual(0.18 * 1920 - 1);
    expect(layout.alignment).toBe(2);
  });

  it('moves the block off the subject band when the safe area allows it', () => {
    const result = planSubtitleLayout({ anchor: 'top', subjectBand: { topFraction: 0.05, bottomFraction: 0.5 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.layout.requestedAnchor).toBe('top');
    expect(result.layout.anchor).toBe('bottom');
    expect(result.layout.notes).toContain('anchor_moved_off_subject');
    expect(layoutClearsSubject(result.layout)).toBe(true);
  });

  it('keeps the caption on frame and says so when the band cannot be dodged', () => {
    const result = planSubtitleLayout({ subjectBand: { topFraction: 0, bottomFraction: 1 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.layout.notes).toContain('subject_band_unavoidable');
    expect(boxWithinFrame(result.layout.box, result.layout.output)).toBe(true);
  });

  it('rejects geometry it cannot lay out', () => {
    expect(planSubtitleLayout({ output: { width: 0, height: 1920 } })).toEqual({
      ok: false,
      reason: 'invalid_output_dimensions',
    });
    expect(planSubtitleLayout({ safeArea: { top: 0.6, bottom: 0.6, left: 0, right: 0 } })).toEqual({
      ok: false,
      reason: 'invalid_safe_area',
    });
    expect(planSubtitleLayout({ fontSizeFraction: 0 })).toEqual({
      ok: false,
      reason: 'invalid_font_size',
    });
    expect(planSubtitleLayout({ output: { width: 108, height: 192 }, maxLines: 16 })).toEqual({
      ok: false,
      reason: 'safe_area_too_small',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

describe('cue validation', () => {
  const cue = (overrides: Partial<SubtitleSegment> = {}): SubtitleSegment => ({
    index: 0,
    startSec: 0,
    endSec: 1,
    lines: ['hello there'],
    words: null,
    ...overrides,
  });

  it('accepts a well-formed cue list', () => {
    expect(validateSubtitleSegments([cue(), cue({ index: 1, startSec: 1, endSec: 2 })], 10)).toEqual(
      [],
    );
  });

  it.each([
    ['overlaps_previous', [cue(), cue({ index: 1, startSec: 0.5, endSec: 2 })]],
    ['index_disordered', [cue({ index: 3 }), cue({ index: 1, startSec: 1, endSec: 2 })]],
    ['empty_text', [cue({ lines: ['   '] })]],
    ['invalid_range', [cue({ startSec: 2, endSec: 1 })]],
    ['outside_clip', [cue({ startSec: 9, endSec: 12 })]],
    ['too_many_lines', [cue({ lines: ['a', 'b', 'c'] })]],
    ['exceeds_max_duration', [cue({ endSec: 9 })]],
  ])('reports %s', (code, segments) => {
    expect(validateSubtitleSegments(segments, 10).map((issue) => issue.code)).toContain(code);
  });

  it('rejects words timed outside the cue that carries them', () => {
    const issues = validateSubtitleSegments(
      [cue({ lines: ['hello'], words: [{ text: 'hello', startSec: 0, endSec: 5 }] })],
      10,
    );

    expect(issues.map((issue) => issue.code)).toContain('word_outside_cue');
  });

  it('rejects a cue whose text no longer matches its own words', () => {
    const issues = validateSubtitleSegments(
      [cue({ lines: ['goodbye'], words: [{ text: 'hello', startSec: 0, endSec: 1 }] })],
      10,
    );

    expect(issues.map((issue) => issue.code)).toContain('word_text_mismatch');
  });

  it('verifies cue text against the transcript', () => {
    const source = 'We tried it anyway and it worked.';

    expect(verifySubtitleFidelity([cue({ lines: ['We tried it anyway'] })], source)).toEqual([]);
    // Case and punctuation are allowed to differ; words are not.
    expect(verifySubtitleFidelity([cue({ lines: ['we tried it, anyway'] })], source)).toEqual([]);
    expect(
      verifySubtitleFidelity([cue({ lines: ['We nearly tried it'] })], source).map((i) => i.code),
    ).toEqual(['not_verbatim']);
  });
});

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

describe('subtitle plan', () => {
  const segments = [
    timedSegment(0, [
      ['We', 10, 10.3],
      ['tried', 10.3, 10.7],
      ['it', 10.7, 10.9],
      ['anyway.', 10.9, 11.4],
    ]),
    timedSegment(1, [
      ['It', 30, 30.3],
      ['worked', 30.3, 30.8],
      ['perfectly.', 30.8, 31.4],
    ]),
  ];

  it('times cues against the clip, not the source', () => {
    const result = buildSubtitlePlan({ cuts: [cut(10, 20, 0), cut(30, 35, 1)], segments });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { plan } = result;
    expect(plan.clipDurationSec).toBe(15);
    expect(plan.segments[0]!.startSec).toBeCloseTo(0, 6);
    expect(plan.segments[1]!.startSec).toBeCloseTo(10, 6);
    expect(subtitlePlanText(plan.segments)).toBe('We tried it anyway. It worked perfectly.');
    expect(plan.segments.map((cue) => cue.index)).toEqual([0, 1]);
  });

  it('never lets a cue span two cuts', () => {
    const result = buildSubtitlePlan({
      cuts: [cut(10, 11.4, 0), cut(30, 31.4, 1)],
      segments,
      // Wide enough that only the cut boundary can end the first cue.
      options: { maxWordsPerCaption: 20, maxDurationSec: 30, breakOnSentenceEnd: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.segments.map(subtitleText)).toEqual([
      'We tried it anyway.',
      'It worked perfectly.',
    ]);
    expect(result.plan.segments[0]!.endSec).toBeLessThanOrEqual(1.4001);
  });

  it('resolves the character budget from the layout when none is configured', () => {
    const result = buildSubtitlePlan({ cuts: [cut(10, 20, 0)], segments });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.options.maxCharsPerLine).toBe(result.plan.layout.maxCharsPerLine);
    expect(result.plan.options.maxLines).toBe(result.plan.layout.maxLines);
  });

  it('produces a plan its own validator accepts', () => {
    const result = buildSubtitlePlan({ cuts: [cut(10, 20, 0), cut(30, 35, 1)], segments });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(validateSubtitleSegments(result.plan.segments, result.plan.clipDurationSec, result.plan.options)).toEqual([]);
    expect(verifySubtitleFidelity(result.plan.segments, 'We tried it anyway. It worked perfectly.')).toEqual([]);
  });

  it('carries the estimate forward when the transcript has no word timings', () => {
    const result = buildSubtitlePlan({
      cuts: [cut(0, 10, 0)],
      segments: [plainSegment(0, 0, 4, 'We tried it anyway.')],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.notes).toContain('no_word_timings');
    expect(result.plan.segments[0]!.timingSource).toBe('segment');
  });

  it('returns an empty, noted plan for a silent clip', () => {
    const result = buildSubtitlePlan({ cuts: [cut(0, 10, 0)], segments: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.segments).toEqual([]);
    expect(result.plan.notes).toContain('no_cues');
  });

  it('refuses a clip with no playable cuts', () => {
    expect(buildSubtitlePlan({ cuts: [], segments })).toEqual({ ok: false, reason: 'empty_clip' });
  });

  it.each([
    { minDurationSec: 5, maxDurationSec: 3 },
    { maxWordsPerCaption: 0 },
    { maxCharsPerLine: 0 },
    { breakOnPauseSec: -1 },
  ])('refuses contradictory options %o', (options) => {
    expect(buildSubtitlePlan({ cuts: [cut(10, 20, 0)], segments, options })).toEqual({
      ok: false,
      reason: 'invalid_options',
    });
  });

  it('passes a layout failure through unchanged', () => {
    expect(
      buildSubtitlePlan({ cuts: [cut(10, 20, 0)], segments, layout: { fontSizeFraction: 0.9 } }),
    ).toEqual({ ok: false, reason: 'invalid_font_size' });
  });
});

/* -------------------------------------------------------------------------- */
/* ASS rendering                                                              */
/* -------------------------------------------------------------------------- */

describe('ASS rendering', () => {
  const planFor = (options: Partial<SubtitleOptions> = {}) => {
    const result = buildSubtitlePlan({
      cuts: [cut(10, 20, 0)],
      segments: [
        timedSegment(0, [
          ['We', 10, 10.3],
          ['tried', 10.3, 10.7],
          ['it', 10.7, 10.9],
          ['anyway.', 10.9, 11.4],
        ]),
      ],
      options,
    });
    if (!result.ok) throw new Error(`plan failed: ${result.reason}`);
    return result.plan;
  };

  it('declares the play resolution the layout was computed for', () => {
    const document = renderAssDocument(planFor());

    expect(document).toContain('PlayResX: 1080');
    expect(document).toContain('PlayResY: 1920');
    expect(document).toContain('ScaledBorderAndShadow: yes');
    // The plan decided the line breaks; libass must not re-wrap them.
    expect(document).toContain('WrapStyle: 2');
  });

  it('writes the layout geometry into the style row', () => {
    const plan = planFor();
    const style = renderAssDocument(plan)
      .split('\n')
      .find((line) => line.startsWith('Style:'))!;
    const fields = style.split(',');

    expect(fields[2]).toBe(String(plan.layout.fontSizePx));
    expect(fields[18]).toBe(String(plan.layout.alignment));
    expect(fields[19]).toBe(String(plan.layout.marginLeftPx));
    expect(fields[20]).toBe(String(plan.layout.marginRightPx));
    expect(fields[21]).toBe(String(plan.layout.marginVerticalPx));
  });

  it('writes one dialogue row per cue, timed on the clip', () => {
    const rows = renderAssDocument(planFor())
      .split('\n')
      .filter((line) => line.startsWith('Dialogue:'));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe('Dialogue: 0,0:00:00.00,0:00:01.40,Caption,,0,0,0,,We tried it anyway.');
  });

  it('hard-breaks multi-line cues with \\N', () => {
    const plan = planFor({ maxCharsPerLine: 10 });
    const row = renderAssDocument(plan)
      .split('\n')
      .find((line) => line.startsWith('Dialogue:'))!;

    expect(plan.segments[0]!.lines.length).toBeGreaterThan(1);
    expect(row).toContain('\\N');
    expect(row.slice(row.lastIndexOf(',,') + 2).split('\\N').join(' ')).toBe('We tried it anyway.');
  });

  it('escapes ASS syntax instead of dropping it', () => {
    expect(escapeAssText('a {b} c\\d')).toBe('a \\{b\\} c\\\\d');
    expect(escapeAssText('one\ntwo')).toBe('one\\Ntwo');
  });

  it.each([
    [0, '0:00:00.00'],
    [1.4, '0:00:01.40'],
    [61.239, '0:01:01.23'],
    [3661.5, '1:01:01.50'],
    [-1, '0:00:00.00'],
  ])('formats %s as %s', (seconds, expected) => {
    expect(formatAssTime(seconds)).toBe(expected);
  });

  it('quotes and escapes a subtitle path so a Windows drive letter survives the filtergraph', () => {
    // Both are needed: the quotes carry the space, the escaped colon stops the
    // filtergraph splitting the drive letter off as its own argument.
    expect(subtitlesFilter('C:\\clips\\a b.ass')).toBe("subtitles=filename='C\\:/clips/a b.ass'");
    expect(subtitlesFilter("/tmp/o'brien.ass")).toBe("subtitles=filename='/tmp/o'\\''brien.ass'");
  });
});
