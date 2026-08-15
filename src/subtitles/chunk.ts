/**
 * Timed words → readable cues.
 *
 * This is the only place that decides *where a caption ends*, and it decides it
 * from how people speak rather than from a character budget alone. Four signals,
 * in descending strength:
 *
 *  1. **A sentence ended.** `.`, `?`, `!`, `…` — the strongest boundary there
 *     is, and the one a viewer already expects a caption to respect.
 *  2. **The speaker paused.** A silent gap is a boundary the audio makes
 *     audible; breaking anywhere else across it would leave a caption hanging
 *     over silence.
 *  3. **A clause ended**, once the cue already carries enough words to be worth
 *     ending. The word guard is what stops every comma producing a two-word cue.
 *  4. **A limit was hit** — words, seconds, or the characters the layout says
 *     fit. These are the fallback, not the plan: reaching one means no natural
 *     boundary arrived in time.
 *
 * What this module never does is touch the text. Cues are *partitions* of the
 * word list — every word appears in exactly one cue, spelled as the transcript
 * spells it, in transcript order. Joining every cue's lines with single spaces
 * reproduces the input exactly, which is what makes the verbatim guarantee
 * checkable rather than asserted.
 *
 * Pure: words in, cues out, no clock and no I/O.
 */

import {
  estimateTextUnits,
  lineBudgetUnits,
  type SubtitleOptions,
  type SubtitleSegment,
  type SubtitleSourceWord,
  type SubtitleTimingSource,
  type TranscriptSegmentId,
} from '@/domain';

export interface ChunkConfig {
  readonly options: SubtitleOptions;
  /** Characters that fit one display line. Normally from the resolved layout. */
  readonly maxCharsPerLine: number;
  /** Runtime of the Short; cue ends are never pushed past it. */
  readonly clipDurationSec: number;
  /** Index the first cue is numbered from, so cuts can be chunked separately. */
  readonly startIndex?: number;
}

/** Sentence terminators. `…` counts: a trailing-off is still a full stop. */
const SENTENCE_END = /[.?!…]$/u;

/** Clause boundaries, weaker than a full stop but still a place to breathe. */
const CLAUSE_END = /[,;:—–]$/u;

/** Trailing quotes and brackets, stripped before looking at the punctuation. */
const TRAILING_WRAPPERS = /["'”’)\]}»]+$/u;

/**
 * Tokens whose full stop is not a sentence end.
 *
 * Deliberately short: this is not an attempt at abbreviation detection, only a
 * guard against the handful of forms common enough in speech transcripts that
 * breaking on them is visibly wrong. Initials (`J.`) are caught by the single
 * letter rule below rather than listed.
 */
const ABBREVIATIONS = new Set([
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'st.',
  'vs.',
  'etc.',
  'e.g.',
  'i.e.',
  'a.m.',
  'p.m.',
  'u.s.',
  'u.k.',
]);

/** A single capital plus a stop — an initial, not the end of a thought. */
const INITIAL = /^\p{Lu}\.$/u;

/** Floor on a cue's span, so a degenerate word still yields a forward range. */
const MIN_CUE_SPAN_SEC = 0.001;

/**
 * Split words into cues.
 *
 * The loop is deliberately one-pass and greedy: a word either joins the open cue
 * or starts a new one, decided from the cue so far and the gap behind the word.
 * A global optimiser could balance line lengths better, but it would also be
 * able to move a boundary away from a sentence end to save a character, and
 * that trade is not one a caption should make.
 */
export function chunkWordsIntoCues(
  words: readonly SubtitleSourceWord[],
  config: ChunkConfig,
): SubtitleSegment[] {
  const groups = groupWords(words, config);
  const merged = config.options.mergeShortCues ? mergeOrphans(groups, config) : groups;
  return materialize(merged, config);
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                   */
/* -------------------------------------------------------------------------- */

type Group = SubtitleSourceWord[];

function groupWords(words: readonly SubtitleSourceWord[], config: ChunkConfig): Group[] {
  const { options } = config;
  const groups: Group[] = [];
  let current: Group = [];

  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };

  for (const word of words) {
    const previous = current[current.length - 1];

    if (previous) {
      const gapSec = word.startSec - previous.endSec;
      const wouldRunSec = word.endSec - current[0]!.startSec;

      if (
        current.length >= options.maxWordsPerCaption ||
        gapSec >= options.breakOnPauseSec ||
        wouldRunSec > options.maxDurationSec ||
        !fitsLines([...current, word], config)
      ) {
        flush();
      }
    }

    current.push(word);

    // A cue of one word is a legitimate sentence ("Exactly."), so the sentence
    // rule needs no word guard — unlike the clause rule, which has one.
    if (options.breakOnSentenceEnd && endsSentence(word.text)) {
      flush();
      continue;
    }

    if (
      options.breakOnClauseAfterWords > 0 &&
      current.length >= options.breakOnClauseAfterWords &&
      CLAUSE_END.test(word.text)
    ) {
      flush();
    }
  }

  flush();
  return groups;
}

/**
 * Fold a stranded one- or two-word cue back into the cue before it.
 *
 * Only when the result still obeys every cap, so a merge can never produce a cue
 * the validator would reject — and never across a pause. A pause break was made
 * for a reason the viewer can *hear*; re-joining over it would leave the caption
 * hanging through the silence, which is the one thing the pause rule exists to
 * prevent. The orphan keeps its own cue instead.
 */
function mergeOrphans(groups: readonly Group[], config: ChunkConfig): Group[] {
  const { options } = config;
  const merged: Group[] = [];

  for (const group of groups) {
    const previous = merged[merged.length - 1];
    const isOrphan =
      previous !== undefined &&
      group.length <= 2 &&
      group[group.length - 1]!.endSec - group[0]!.startSec < options.minDurationSec &&
      group[0]!.startSec - previous[previous.length - 1]!.endSec < options.breakOnPauseSec;

    if (!isOrphan) {
      merged.push([...group]);
      continue;
    }

    const combined = [...previous, ...group];
    const fits =
      combined.length <= options.maxWordsPerCaption &&
      combined[combined.length - 1]!.endSec - combined[0]!.startSec <= options.maxDurationSec &&
      fitsLines(combined, config);

    if (fits) merged[merged.length - 1] = combined;
    else merged.push([...group]);
  }

  return merged;
}

/* -------------------------------------------------------------------------- */
/* Materialisation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Groups → cues, with the timing decided last.
 *
 * A cue's span is its words' span, then stretched to `minDurationSec` so a fast
 * word is still readable. The stretch is bounded by the next cue's start and by
 * the clip's end: a caption that stayed up into the next one would overlap it,
 * and the validator rejects overlaps rather than tolerating them.
 */
function materialize(groups: readonly Group[], config: ChunkConfig): SubtitleSegment[] {
  const { options } = config;
  const startIndex = config.startIndex ?? 0;

  return groups.map((words, position) => {
    const startSec = words[0]!.startSec;
    const naturalEnd = words[words.length - 1]!.endSec;

    const nextStart = groups[position + 1]?.[0]?.startSec ?? config.clipDurationSec;
    const ceiling = Math.min(nextStart, config.clipDurationSec);
    const stretched = Math.max(naturalEnd, Math.min(startSec + options.minDurationSec, ceiling));

    // A single word can outlast the duration cap — the grouping loop has nothing
    // to split. The cue is cut short rather than the word being dropped or the
    // cap quietly waived: the text stays whole, only its dwell time is trimmed.
    const endSec = Math.max(startSec + MIN_CUE_SPAN_SEC, Math.min(stretched, startSec + options.maxDurationSec));

    return {
      index: startIndex + position,
      startSec,
      endSec,
      lines: layoutLines(words.map((word) => word.text), config.maxCharsPerLine),
      words: words.map((word) => ({
        startSec: word.startSec,
        // Kept inside the cue that carries it, for the same reason: a word timed
        // past its own caption is a highlight the renderer cannot draw.
        endSec: Math.min(word.endSec, endSec),
        text: word.text,
        sourceSegmentId: word.sourceSegmentId,
      })),
      sourceSegmentIds: uniqueSegmentIds(words),
      timingSource: cueTimingSource(words),
    } satisfies SubtitleSegment;
  });
}

/**
 * Break a cue's words across display lines.
 *
 * Greedy fill, and words are never split: a word longer than the line budget
 * overflows its line rather than being hyphenated, because hyphenating is
 * editing. Fit is measured with `estimateTextUnits` rather than by counting
 * characters, because a proportional font makes those two very different
 * questions — 22 narrow characters fit comfortably where 22 wide ones run off
 * the frame entirely.
 */
export function layoutLines(texts: readonly string[], maxCharsPerLine: number): string[] {
  const usable = Number.isFinite(maxCharsPerLine) && maxCharsPerLine > 0;
  const budget = usable ? lineBudgetUnits(maxCharsPerLine) : Infinity;
  const lines: string[] = [];
  let current = '';

  for (const text of texts) {
    if (current.length === 0) {
      current = text;
      continue;
    }

    const candidate = `${current} ${text}`;
    if (estimateTextUnits(candidate) > budget) {
      lines.push(current);
      current = text;
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

/** Whether these words lay out inside the configured line count. */
const fitsLines = (words: readonly SubtitleSourceWord[], config: ChunkConfig): boolean =>
  layoutLines(words.map((word) => word.text), config.maxCharsPerLine).length <=
  config.options.maxLines;

/**
 * Whether a token ends a sentence.
 *
 * Wrappers come off first so `"Really?"` and `(yes.)` are seen as the sentence
 * ends they are, and the abbreviation and initial guards keep `Dr.` and `J.`
 * attached to what follows them.
 */
export function endsSentence(text: string): boolean {
  const trimmed = text.replace(TRAILING_WRAPPERS, '');
  if (!SENTENCE_END.test(trimmed)) return false;
  if (ABBREVIATIONS.has(trimmed.toLowerCase())) return false;
  return !INITIAL.test(trimmed);
}

/** `word` only when every boundary in the cue was measured, never apportioned. */
const cueTimingSource = (words: readonly SubtitleSourceWord[]): SubtitleTimingSource =>
  words.every((word) => word.timingSource === 'word') ? 'word' : 'segment';

function uniqueSegmentIds(words: readonly SubtitleSourceWord[]): TranscriptSegmentId[] {
  const ids: TranscriptSegmentId[] = [];

  for (const word of words) {
    const id = word.sourceSegmentId;
    if (id !== null && ids[ids.length - 1] !== id) ids.push(id);
  }

  return ids;
}
