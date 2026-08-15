/**
 * Subtitles: types, 9:16 layout geometry, and validation.
 *
 * The rule this whole subsystem exists to keep is stated once, here: **a
 * subtitle is a slice of the transcript, timed**. Nothing in this file or in
 * `@/subtitles` writes, rewrites, translates, summarises or case-folds speech.
 * Segmentation and line breaking are ours; the characters are the speaker's.
 *
 * Three shapes live here:
 *
 *  1. `SubtitleSegment` — one cue on the *clip* timeline (0 = first frame of
 *     the Short), carrying the verbatim lines and, where the provider gave word
 *     timings, the words behind them.
 *  2. `SubtitleLayout` — where cues are allowed to sit in the output frame,
 *     derived from a safe-area model and a configurable band reserved for the
 *     visual subject. Pure integer geometry, exactly like `crop.ts`: no
 *     detection happens here, the band is an input.
 *  3. The validators — a cue list is *rejected with a reason*, never repaired.
 */

import type { TimeRange } from './common';
import { isValidDimensions, type Dimensions } from './crop';
import type { TranscriptSegmentId } from './transcript';
import { verifyQuote } from './verbatim';
import { SHORTS_OUTPUT_HEIGHT, SHORTS_OUTPUT_WIDTH } from './video';

/* -------------------------------------------------------------------------- */
/* Cues                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Where a cue's timing came from.
 *
 * `word` means every boundary is a provider-reported word timestamp. `segment`
 * means the provider only timed whole segments and the per-word times were
 * apportioned across the segment's own span — an *estimate of timing*, never of
 * text. The distinction is carried on the cue so a caller can tell precise
 * timing from apportioned timing without re-reading the transcript.
 */
export type SubtitleTimingSource = 'word' | 'segment';

/** Optional word-level timing, used for karaoke-style highlighting later. */
export interface SubtitleWord extends TimeRange {
  readonly text: string;
  /** Transcript segment the word was read from, when known. */
  readonly sourceSegmentId?: TranscriptSegmentId | null;
}

/**
 * A subtitle cue on the **clip** timeline (0 = first frame of the Short).
 *
 * Text is always taken verbatim from the transcript — only segmentation and
 * line breaking are decided by us.
 */
export interface SubtitleSegment extends TimeRange {
  readonly index: number;
  /** Display lines, already broken for the 9:16 safe area. */
  readonly lines: readonly string[];
  readonly words: readonly SubtitleWord[] | null;
  /** Transcript segments this cue draws from, in order, when known. */
  readonly sourceSegmentIds?: readonly TranscriptSegmentId[];
  /** How the cue's boundaries were obtained. Absent on hand-built cues. */
  readonly timingSource?: SubtitleTimingSource;
}

/** Flattens a cue back to a single string. */
export const subtitleText = (segment: SubtitleSegment): string => segment.lines.join(' ');

/** Every cue's text, in order — the verbatim speech the burn-in will show. */
export const subtitlePlanText = (segments: readonly SubtitleSegment[]): string =>
  segments.map(subtitleText).join(' ');

/* -------------------------------------------------------------------------- */
/* Chunking options                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How word timings are turned into readable cues.
 *
 * Every value is a *reading* constraint, not a stylistic one. The defaults are
 * the ones that make a 9:16 caption readable at arm's length: a handful of
 * words, on screen long enough to be read and not so long that it lags the
 * speech.
 */
export interface SubtitleOptions {
  /** Hard cap on words in one cue. */
  readonly maxWordsPerCaption: number;
  /** A cue is never held longer than this, even mid-phrase. */
  readonly maxDurationSec: number;
  /** A cue is held at least this long, so a fast word is still readable. */
  readonly minDurationSec: number;
  /** Characters per display line, before a line break is forced. */
  readonly maxCharsPerLine: number | null;
  /** Display lines per cue. */
  readonly maxLines: number;
  /** A silent gap of at least this long ends the cue: speakers pause at ideas. */
  readonly breakOnPauseSec: number;
  /** End a cue on `.`, `?`, `!`, `…` — the strongest boundary available. */
  readonly breakOnSentenceEnd: boolean;
  /**
   * End a cue on `,`, `;`, `:`, `—` once it already carries this many words.
   * Zero disables clause breaks; the guard stops a two-word cue on every comma.
   */
  readonly breakOnClauseAfterWords: number;
  /**
   * Merge an orphaned cue — one or two words, shorter than `minDurationSec` —
   * into its predecessor when the combination still fits the word, character
   * and duration caps. Without it, a trailing "…yeah." gets a cue of its own.
   */
  readonly mergeShortCues: boolean;
}

export const DEFAULT_SUBTITLE_OPTIONS: SubtitleOptions = {
  maxWordsPerCaption: 6,
  maxDurationSec: 3.2,
  minDurationSec: 0.7,
  // Null means "ask the layout": the safe area and font size decide how many
  // characters actually fit, which is a geometry question, not a taste one.
  maxCharsPerLine: null,
  maxLines: 2,
  breakOnPauseSec: 0.45,
  breakOnSentenceEnd: true,
  breakOnClauseAfterWords: 3,
  mergeShortCues: true,
};

/** One transcript word, already mapped onto the clip timeline. */
export interface SubtitleSourceWord extends TimeRange {
  /** Verbatim, exactly as the transcript spells it. */
  readonly text: string;
  readonly sourceSegmentId: TranscriptSegmentId | null;
  readonly timingSource: SubtitleTimingSource;
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

/** A rectangle in output-frame pixels. Origin is the top-left corner. */
export interface SubtitleBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Fractions of the output frame that must stay clear of caption text. */
export interface SubtitleInsets {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/**
 * Default 9:16 safe area.
 *
 * The bottom inset is the largest because that is where every Shorts-style
 * player puts its own chrome — title, handle, progress bar. Text that lands
 * under it is not "slightly clipped", it is unreadable on the platform it was
 * made for.
 */
export const DEFAULT_SUBTITLE_SAFE_AREA: SubtitleInsets = {
  top: 0.1,
  bottom: 0.18,
  left: 0.06,
  right: 0.06,
};

/**
 * The horizontal band of the frame the visual subject is expected to occupy,
 * as fractions of the output height.
 *
 * This is an **input**, not a detection: the subtitle engine never looks at
 * pixels. The tracking phase, or a caller that knows better, may narrow it; the
 * default covers where a head sits in a centre-framed 9:16 crop. Layout keeps
 * the caption block out of this band when the safe area allows it.
 */
export interface SubjectBand {
  readonly topFraction: number;
  readonly bottomFraction: number;
}

export const DEFAULT_SUBJECT_BAND: SubjectBand = { topFraction: 0.1, bottomFraction: 0.68 };

/** Where the caption block is anchored inside the safe area. */
export type SubtitleAnchor = 'top' | 'middle' | 'bottom';

/** ASS numpad alignment for a centred block at each anchor. */
export const ASS_ALIGNMENT: Readonly<Record<SubtitleAnchor, 2 | 5 | 8>> = {
  bottom: 2,
  middle: 5,
  top: 8,
};

export interface SubtitleLayoutConfig {
  /** Defaults to 1080×1920. */
  readonly output?: Dimensions;
  /** Preferred anchor. May be overridden to dodge the subject band. */
  readonly anchor?: SubtitleAnchor;
  readonly safeArea?: SubtitleInsets;
  /** Null opts out of subject avoidance entirely. */
  readonly subjectBand?: SubjectBand | null;
  /** Font size as a fraction of the output height. */
  readonly fontSizeFraction?: number;
  /** Line box height as a multiple of the font size. */
  readonly lineSpacing?: number;
  readonly maxLines?: number;
}

/**
 * The resolved geometry a renderer needs: a rectangle, a font size, and the
 * ASS margins that place the same rectangle in libass' coordinate system.
 */
export interface SubtitleLayout {
  readonly output: Dimensions;
  /** Where the block actually sits. */
  readonly anchor: SubtitleAnchor;
  /** What the caller asked for, kept when the two differ. */
  readonly requestedAnchor: SubtitleAnchor;
  readonly safeArea: SubtitleBox;
  /** The caption block itself, inside `safeArea`. */
  readonly box: SubtitleBox;
  /** The reserved band in pixels, or null when avoidance was switched off. */
  readonly subjectBand: SubtitleBox | null;
  readonly fontSizePx: number;
  readonly lineHeightPx: number;
  readonly maxLines: number;
  /** Characters that fit one line at this width and size. */
  readonly maxCharsPerLine: number;
  readonly marginLeftPx: number;
  readonly marginRightPx: number;
  /**
   * ASS `MarginV`: the gap from the frame edge the alignment measures against —
   * the bottom edge for alignment 2, the top edge for 8. Ignored by libass for
   * the middle alignment, which centres the block.
   */
  readonly marginVerticalPx: number;
  readonly alignment: 2 | 5 | 8;
  /** Machine-readable notes, e.g. `subject_band_unavoidable`. */
  readonly notes: readonly string[];
}

export type SubtitleLayoutFailureReason =
  | 'invalid_output_dimensions'
  | 'invalid_safe_area'
  | 'invalid_font_size'
  | 'safe_area_too_small';

export type SubtitleLayoutResult =
  | { readonly ok: true; readonly layout: SubtitleLayout }
  | { readonly ok: false; readonly reason: SubtitleLayoutFailureReason };

export const SHORTS_SUBTITLE_OUTPUT: Dimensions = {
  width: SHORTS_OUTPUT_WIDTH,
  height: SHORTS_OUTPUT_HEIGHT,
};

/** Default caption size: ~86px tall on a 1920-high frame. */
export const DEFAULT_FONT_SIZE_FRACTION = 0.045;
export const DEFAULT_LINE_SPACING = 1.22;

/**
 * Per-character advance widths, in fractions of the font size.
 *
 * A flat mean is not good enough here, and the failure it caused is worth
 * recording: at 0.5 the layout advertised 22 characters per line, and 22 wide
 * characters ("WHAT HAPPENED NEXT WAS") measure 1237px at an 86px bold Arial —
 * wider than the whole 1080px frame, not merely wider than the safe area. With
 * `WrapStyle: 2` libass does not wrap, so the caption was clipped off *both*
 * edges. Character width in a proportional font varies by more than 3× (`l` is
 * 0.28, `M` is 0.90), so which characters a line holds decides whether it fits.
 *
 * The values approximate Arial Bold's own advances, grouped into classes rather
 * than tabulated per glyph: measured against libass, the classes land within a
 * few percent of the real set widths, which is well inside the margin a caption
 * needs. Unlisted characters take `DEFAULT_CHAR_UNITS`.
 */
const NARROWEST_CHARS = new Set(['i', 'j', 'l', 'I', '.', ',', "'", '"', '!', ':', ';', '|', '`', ' ']);
const NARROW_CHARS = new Set(['f', 't', 'r', '(', ')', '[', ']', '/', '\\', '-']);
const WIDE_LOWER_CHARS = new Set(['m', 'w']);
const WIDE_UPPER_CHARS = new Set(['M', 'W']);

const NARROWEST_UNITS = 0.28;
const NARROW_UNITS = 0.36;
const WIDE_LOWER_UNITS = 0.85;
const WIDE_UPPER_UNITS = 0.9;
const UPPER_UNITS = 0.7;
const DEFAULT_CHAR_UNITS = 0.6;

/**
 * Mean advance across ordinary prose, used to express a pixel budget as the
 * character count `SubtitleOptions.maxCharsPerLine` is stated in.
 *
 * It is only the *unit* of the budget; what actually decides a line break is
 * `estimateTextUnits`, which measures the characters a line really holds.
 */
const GLYPH_ADVANCE_RATIO = 0.52;

/**
 * Width of `text` in font-size units — multiply by the font size for pixels.
 *
 * Deterministic and dependency-free: no font is loaded and no renderer is
 * consulted, which is what keeps line breaking a pure function that a unit test
 * can pin down exactly.
 */
export function estimateTextUnits(text: string): number {
  let units = 0;

  for (const char of text) {
    if (NARROWEST_CHARS.has(char)) units += NARROWEST_UNITS;
    else if (NARROW_CHARS.has(char)) units += NARROW_UNITS;
    else if (WIDE_UPPER_CHARS.has(char)) units += WIDE_UPPER_UNITS;
    else if (WIDE_LOWER_CHARS.has(char)) units += WIDE_LOWER_UNITS;
    else if (char >= 'A' && char <= 'Z') units += UPPER_UNITS;
    else units += DEFAULT_CHAR_UNITS;
  }

  return units;
}

/** The width budget a `maxCharsPerLine` figure stands for, in the same units. */
export const lineBudgetUnits = (maxCharsPerLine: number): number =>
  maxCharsPerLine * GLYPH_ADVANCE_RATIO;

/** Whether `text` fits a line of `maxCharsPerLine` average-width characters. */
export const fitsLineWidth = (text: string, maxCharsPerLine: number): boolean =>
  estimateTextUnits(text) <= lineBudgetUnits(maxCharsPerLine);

/** Never fewer than this per line, however narrow the frame. */
const MIN_CHARS_PER_LINE = 8;

/**
 * Resolve a layout: safe area in pixels, then a caption block inside it.
 *
 * The block is placed at the requested anchor. If that overlaps the reserved
 * subject band, the opposite anchor is tried; if both overlap — a band wide
 * enough to swallow the whole safe area — the request stands and a note records
 * it. "Where possible" is a real qualifier: covering the subject is preferable
 * to putting the words off-frame, and silently dropping the captions instead is
 * not a repair anyone asked for.
 *
 * Deterministic and integer-valued: the same config always yields the same box.
 */
export function planSubtitleLayout(config: SubtitleLayoutConfig = {}): SubtitleLayoutResult {
  const output = config.output ?? SHORTS_SUBTITLE_OUTPUT;
  if (!isValidDimensions(output)) return { ok: false, reason: 'invalid_output_dimensions' };

  const insets = config.safeArea ?? DEFAULT_SUBTITLE_SAFE_AREA;
  if (!areInsetsValid(insets)) return { ok: false, reason: 'invalid_safe_area' };

  const fontSizeFraction = config.fontSizeFraction ?? DEFAULT_FONT_SIZE_FRACTION;
  const lineSpacing = config.lineSpacing ?? DEFAULT_LINE_SPACING;
  const maxLines = config.maxLines ?? DEFAULT_SUBTITLE_OPTIONS.maxLines;

  if (
    !Number.isFinite(fontSizeFraction) ||
    fontSizeFraction <= 0 ||
    fontSizeFraction >= 0.5 ||
    !Number.isFinite(lineSpacing) ||
    lineSpacing < 1 ||
    !Number.isInteger(maxLines) ||
    maxLines < 1
  ) {
    return { ok: false, reason: 'invalid_font_size' };
  }

  const safeArea: SubtitleBox = {
    x: Math.round(output.width * insets.left),
    y: Math.round(output.height * insets.top),
    width: Math.round(output.width * (1 - insets.left - insets.right)),
    height: Math.round(output.height * (1 - insets.top - insets.bottom)),
  };

  const fontSizePx = Math.max(1, Math.round(output.height * fontSizeFraction));
  const lineHeightPx = Math.max(1, Math.round(fontSizePx * lineSpacing));
  const blockHeight = lineHeightPx * maxLines;

  if (safeArea.width < fontSizePx || safeArea.height < blockHeight) {
    return { ok: false, reason: 'safe_area_too_small' };
  }

  const requestedAnchor = config.anchor ?? 'bottom';
  const band = resolveSubjectBand(config.subjectBand, output);

  const notes: string[] = [];
  let anchor = requestedAnchor;
  let box = anchoredBox(safeArea, blockHeight, anchor);

  if (band && overlaps(box, band)) {
    const alternative = anchor === 'top' ? 'bottom' : 'top';
    const alternativeBox = anchoredBox(safeArea, blockHeight, alternative);

    if (!overlaps(alternativeBox, band)) {
      anchor = alternative;
      box = alternativeBox;
      notes.push('anchor_moved_off_subject');
    } else {
      notes.push('subject_band_unavoidable');
    }
  }

  return {
    ok: true,
    layout: {
      output: { width: output.width, height: output.height },
      anchor,
      requestedAnchor,
      safeArea,
      box,
      subjectBand: band,
      fontSizePx,
      lineHeightPx,
      maxLines,
      maxCharsPerLine: Math.max(
        MIN_CHARS_PER_LINE,
        Math.floor(box.width / (fontSizePx * GLYPH_ADVANCE_RATIO)),
      ),
      marginLeftPx: box.x,
      marginRightPx: Math.max(0, output.width - (box.x + box.width)),
      marginVerticalPx: verticalMargin(box, output, anchor),
      alignment: ASS_ALIGNMENT[anchor],
      notes,
    },
  };
}

/** Whether the block clears the reserved subject band. */
export const layoutClearsSubject = (layout: SubtitleLayout): boolean =>
  layout.subjectBand === null || !overlaps(layout.box, layout.subjectBand);

/** Whether a box lies wholly inside the frame. */
export const boxWithinFrame = (box: SubtitleBox, output: Dimensions): boolean =>
  box.x >= 0 &&
  box.y >= 0 &&
  box.width > 0 &&
  box.height > 0 &&
  box.x + box.width <= output.width &&
  box.y + box.height <= output.height;

function anchoredBox(safeArea: SubtitleBox, blockHeight: number, anchor: SubtitleAnchor): SubtitleBox {
  const y =
    anchor === 'top'
      ? safeArea.y
      : anchor === 'middle'
        ? safeArea.y + Math.round((safeArea.height - blockHeight) / 2)
        : safeArea.y + safeArea.height - blockHeight;

  return { x: safeArea.x, y, width: safeArea.width, height: blockHeight };
}

function verticalMargin(box: SubtitleBox, output: Dimensions, anchor: SubtitleAnchor): number {
  if (anchor === 'top') return box.y;
  if (anchor === 'bottom') return Math.max(0, output.height - (box.y + box.height));
  return 0;
}

function resolveSubjectBand(
  band: SubjectBand | null | undefined,
  output: Dimensions,
): SubtitleBox | null {
  const resolved = band === undefined ? DEFAULT_SUBJECT_BAND : band;
  if (resolved === null) return null;

  const top = clamp01(resolved.topFraction);
  const bottom = clamp01(resolved.bottomFraction);
  if (!(bottom > top)) return null;

  return {
    x: 0,
    y: Math.round(output.height * top),
    width: output.width,
    height: Math.round(output.height * (bottom - top)),
  };
}

/** Vertical overlap is all that matters: both boxes span the frame's width. */
const overlaps = (a: SubtitleBox, b: SubtitleBox): boolean =>
  a.y < b.y + b.height && b.y < a.y + a.height;

function areInsetsValid(insets: SubtitleInsets): boolean {
  const values = [insets.top, insets.bottom, insets.left, insets.right];
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value >= 1)) return false;
  return insets.top + insets.bottom < 1 && insets.left + insets.right < 1;
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything the renderer needs to burn captions onto one clip.
 *
 * A plan is a *description*: cues on the clip timeline plus the geometry they
 * are laid out for. Producing it reads the transcript and nothing else — no
 * media, no clock, no model.
 */
export interface SubtitlePlan {
  /** Runtime of the Short the cues are timed against. */
  readonly clipDurationSec: number;
  readonly segments: readonly SubtitleSegment[];
  readonly layout: SubtitleLayout;
  /** The options in force, resolved from the defaults and the layout. */
  readonly options: SubtitleOptions;
  /** Machine-readable notes, e.g. `no_word_timings`. */
  readonly notes: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export type SubtitleRejectionCode =
  | 'empty_text'
  | 'invalid_range'
  | 'outside_clip'
  | 'overlaps_previous'
  | 'index_disordered'
  | 'too_many_lines'
  | 'exceeds_max_duration'
  | 'word_outside_cue'
  | 'word_text_mismatch'
  | 'not_verbatim';

export interface SubtitleIssue {
  readonly code: SubtitleRejectionCode;
  readonly reason: string;
  /** Position in the cue list the issue was found at. */
  readonly index: number;
}

/** Float slack when comparing cue times to each other and to the clip length. */
const TIME_EPSILON = 0.001;

/**
 * Every way a cue list can be unusable, listed rather than thrown.
 *
 * The checks are deliberately structural — order, bounds, overlap, emptiness.
 * Whether the *text* is faithful is a separate question, answered by
 * `verifyQuote` against the clip's transcript text, because that is the check
 * that must never be weakened by living next to cosmetic ones.
 */
export function validateSubtitleSegments(
  segments: readonly SubtitleSegment[],
  clipDurationSec: number,
  options: SubtitleOptions = DEFAULT_SUBTITLE_OPTIONS,
): SubtitleIssue[] {
  const issues: SubtitleIssue[] = [];
  let previousEnd = -Infinity;
  let previousIndex = -Infinity;

  segments.forEach((cue, position) => {
    const fail = (code: SubtitleRejectionCode, reason: string) =>
      issues.push({ code, reason, index: position });

    if (!Number.isInteger(cue.index) || cue.index <= previousIndex) {
      fail('index_disordered', 'Cue indices must be integers in ascending order.');
    }
    previousIndex = cue.index;

    if (
      !Number.isFinite(cue.startSec) ||
      !Number.isFinite(cue.endSec) ||
      cue.startSec < 0 ||
      cue.endSec <= cue.startSec
    ) {
      fail('invalid_range', 'Cue is not a forward time range starting at or after zero.');
      return;
    }

    if (cue.endSec > clipDurationSec + TIME_EPSILON) {
      fail('outside_clip', `Cue ends at ${cue.endSec}s, past the ${clipDurationSec}s clip.`);
    }

    if (cue.startSec + TIME_EPSILON < previousEnd) {
      fail('overlaps_previous', 'Cue starts before the previous cue ends.');
    }
    previousEnd = cue.endSec;

    if (cue.lines.length === 0 || cue.lines.every((line) => line.trim().length === 0)) {
      fail('empty_text', 'Cue carries no text.');
    }

    if (cue.lines.length > options.maxLines) {
      fail('too_many_lines', `Cue has ${cue.lines.length} lines; the limit is ${options.maxLines}.`);
    }

    if (cue.endSec - cue.startSec > options.maxDurationSec + TIME_EPSILON) {
      fail('exceeds_max_duration', `Cue runs ${(cue.endSec - cue.startSec).toFixed(2)}s.`);
    }

    for (const word of cue.words ?? []) {
      if (
        !Number.isFinite(word.startSec) ||
        !Number.isFinite(word.endSec) ||
        word.startSec + TIME_EPSILON < cue.startSec ||
        word.endSec > cue.endSec + TIME_EPSILON
      ) {
        fail('word_outside_cue', `Word "${word.text}" is timed outside the cue that carries it.`);
        break;
      }
    }

    // The words are the cue's provenance; if they no longer spell the displayed
    // text, one of the two has been edited and neither can be trusted.
    if (cue.words && cue.words.length > 0) {
      const fromWords = cue.words.map((word) => word.text).join(' ');
      if (fromWords !== subtitleText(cue)) {
        fail('word_text_mismatch', 'Cue text does not match the words it references.');
      }
    }
  });

  return issues;
}

export const validateSubtitlePlan = (plan: SubtitlePlan): SubtitleIssue[] =>
  validateSubtitleSegments(plan.segments, plan.clipDurationSec, plan.options);

export const isSubtitlePlanValid = (plan: SubtitlePlan): boolean =>
  validateSubtitlePlan(plan).length === 0;

/**
 * The check the structural validator deliberately leaves out: is every cue
 * *actually* the speaker's words?
 *
 * Each cue is verified independently against the verbatim source text rather
 * than the cue list being verified as one block, because cues are built per cut:
 * two cues either side of a join are contiguous on the clip but not in the
 * source, so a whole-plan check would fail a perfectly faithful plan. Within one
 * cue the words are contiguous speech, which is exactly what `verifyQuote`
 * tests.
 *
 * @param sourceText verbatim transcript text the clip draws from — normally
 *        `ClipPlan.text`.
 */
export function verifySubtitleFidelity(
  segments: readonly SubtitleSegment[],
  sourceText: string,
): SubtitleIssue[] {
  return segments.flatMap((cue, index) => {
    const verification = verifyQuote(subtitleText(cue), sourceText);
    return verification.ok
      ? []
      : [
          {
            code: 'not_verbatim' as const,
            reason: verification.reason ?? 'Cue text is not traceable to the transcript.',
            index,
          },
        ];
  });
}
