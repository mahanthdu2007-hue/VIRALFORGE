/**
 * A `SubtitlePlan` → an ASS document FFmpeg can burn in.
 *
 * ASS rather than SRT, for one reason that decides it: SRT carries no geometry.
 * The layout phase computes a box inside the 9:16 safe area, and the only
 * subtitle format the `subtitles` filter understands that can be *told* about
 * that box — margins, alignment, font size, and a play resolution to measure
 * them against — is ASS. Burning SRT would throw the safe area away at the last
 * step and put the captions wherever libass' defaults land, which on a 1080×1920
 * frame is under the player's own chrome.
 *
 * Three things this module is careful about:
 *
 *  1. **`PlayResX`/`PlayResY` are the layout's output frame.** Every number in
 *     the file — font size, margins — is in those units, so a plan laid out for
 *     1080×1920 renders identically at any scale libass is asked for.
 *  2. **Text stays verbatim.** Braces and backslashes are ASS' own syntax, so
 *     they are escaped rather than removed; what the viewer reads is character
 *     for character what the transcript says. Line breaks use `\N`, the hard
 *     break, because the plan has already decided where the lines go.
 *  3. **It is a string, not a file.** Nothing here writes to disk or spawns
 *     anything; the caller owns where the document lands. That keeps the exact
 *     document an assertion in a unit test.
 */

import type { SubtitleLayout, SubtitlePlan, SubtitleSegment } from '@/domain';

/**
 * Caption appearance. Geometry comes from the layout; this is what is left.
 *
 * Colours are ASS `&HAABBGGRR` — alpha first, then *blue* to red, which is the
 * reverse of the usual hex order and the single easiest thing to get wrong here.
 */
export interface SubtitleStyle {
  readonly fontName: string;
  readonly bold: boolean;
  /** Fill colour, `&HAABBGGRR`. Default is opaque white. */
  readonly primaryColour: string;
  /** Outline colour. Default is opaque black. */
  readonly outlineColour: string;
  /** Box/shadow colour, used when `borderStyle` is 3. */
  readonly backColour: string;
  /** Outline width in play-resolution pixels. */
  readonly outlineWidth: number;
  readonly shadowDepth: number;
  /** 1 = outline + drop shadow, 3 = opaque box behind the text. */
  readonly borderStyle: 1 | 3;
  /**
   * Colour the word currently being spoken, one word at a time.
   *
   * Off falls back to a single static row per cue. Requires the cue to carry
   * word timings; a cue without them is rendered statically whatever this says,
   * because the alternative is inventing a rhythm the speaker did not have.
   */
  readonly karaoke: boolean;
  /**
   * Fill for the active word, `&HAABBGGRR` like the others.
   *
   * Read as a *highlight*, so it has to survive being on top of arbitrary
   * video: a saturated warm colour against the white the rest of the line uses.
   */
  readonly highlightColour: string;
}

/**
 * A heavy outline and no box.
 *
 * Captions sit over moving video, where a thin outline disappears against a
 * bright frame; the box that would fix that also covers the picture the caption
 * is describing. A 3px outline at 1920 tall is the compromise Shorts have
 * settled on.
 */
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontName: 'Arial',
  bold: true,
  primaryColour: '&H00FFFFFF',
  outlineColour: '&H00000000',
  backColour: '&H80000000',
  outlineWidth: 3,
  shadowDepth: 0,
  borderStyle: 1,
  karaoke: true,
  // Gold: bright enough to read as deliberate against white, and it survives
  // both the dark and blown-out frames a caption has to sit on.
  highlightColour: '&H0000D7FF',
};

/** The style row's name. Every dialogue line references it. */
const STYLE_NAME = 'Caption';

/**
 * Render the whole document.
 *
 * `ScaledBorderAndShadow: yes` matters more than it looks: without it, the
 * outline is measured in *output* pixels while the text is measured in play
 * resolution, so an upscaled render gets a hairline outline around huge text.
 * `WrapStyle: 2` disables libass' own wrapping — the plan decided the lines, and
 * a second opinion from the renderer would undo the safe-area fit.
 */
export function renderAssDocument(plan: SubtitlePlan, style: SubtitleStyle = DEFAULT_SUBTITLE_STYLE): string {
  const { layout } = plan;

  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${layout.output.width}`,
    `PlayResY: ${layout.output.height}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,' +
      ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,' +
      ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleRow(layout, style),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...plan.segments.flatMap((cue) => dialogueRows(cue, style)),
  ];

  return `${lines.join('\n')}\n`;
}

/**
 * The rows one cue becomes: one static row, or one per word when highlighting.
 *
 * Word highlighting is drawn as a series of complete cues rather than with ASS'
 * own `\k` karaoke tags, and the difference is what it looks like. `\k` fills
 * the line progressively and leaves everything behind the cursor recoloured,
 * which reads as a lyric sheet. Redrawing the whole line once per word, with
 * only that word tinted, is the Shorts convention: the sentence stays legible
 * and one word is picked out of it.
 *
 * The words tile the cue exactly — each is shown until the next one starts, and
 * the last holds to the cue's end — so there is no frame where the caption
 * blinks out between words.
 */
export function dialogueRows(cue: SubtitleSegment, style: SubtitleStyle = DEFAULT_SUBTITLE_STYLE): string[] {
  const words = cue.words ?? [];
  if (!style.karaoke || words.length === 0) return [row(cue.startSec, cue.endSec, assText(cue))];

  const lineLengths = cue.lines.map((line) => line.split(' ').filter((w) => w.length > 0).length);
  // The validator already guarantees the words spell the lines; if some caller
  // hand-built a cue where they do not, a static row is the honest fallback.
  if (lineLengths.reduce((sum, n) => sum + n, 0) !== words.length) {
    return [row(cue.startSec, cue.endSec, assText(cue))];
  }

  const normal = inlineColour(style.primaryColour);
  const highlight = inlineColour(style.highlightColour);

  return words.flatMap((word, index) => {
    const startSec = index === 0 ? cue.startSec : Math.max(word.startSec, cue.startSec);
    const endSec = index === words.length - 1 ? cue.endSec : words[index + 1]!.startSec;
    if (!(endSec > startSec)) return [];

    return [row(startSec, endSec, highlightedText(cue.lines, lineLengths, words, index, normal, highlight))];
  });
}

/** The cue's lines with word `active` tinted, everything else left as it is. */
function highlightedText(
  lines: readonly string[],
  lineLengths: readonly number[],
  words: readonly { readonly text: string }[],
  active: number,
  normal: string,
  highlight: string,
): string {
  const rendered: string[] = [];
  let cursor = 0;

  for (const length of lineLengths) {
    const parts: string[] = [];

    for (let i = cursor; i < cursor + length; i += 1) {
      const text = escapeAssText(words[i]!.text);
      // The override wraps the escaped word, never the other way round, so a
      // transcript containing a brace cannot close the tag it sits inside.
      parts.push(i === active ? `{\\c${highlight}}${text}{\\c${normal}}` : text);
    }

    rendered.push(parts.join(' '));
    cursor += length;
  }

  return rendered.join('\\N');
}

const row = (startSec: number, endSec: number, text: string): string =>
  `Dialogue: 0,${formatAssTime(startSec)},${formatAssTime(endSec)},${STYLE_NAME},,0,0,0,,${text}`;

/**
 * A style colour (`&HAABBGGRR`) as an inline override takes it (`&HBBGGRR&`).
 *
 * Inline `\c` carries no alpha — transparency is `\alpha`'s job — so the alpha
 * byte is dropped rather than passed through, where it would be read as part of
 * the blue channel and silently change the colour.
 */
export function inlineColour(assColour: string): string {
  const hex = assColour.replace(/^&H/iu, '').replace(/&$/u, '');
  const bgr = hex.length >= 8 ? hex.slice(-6) : hex.padStart(6, '0');
  return `&H${bgr.toUpperCase()}&`;
}

const styleRow = (layout: SubtitleLayout, style: SubtitleStyle): string =>
  [
    `Style: ${STYLE_NAME}`,
    style.fontName,
    String(layout.fontSizePx),
    style.primaryColour,
    // Secondary is the karaoke "not yet sung" colour; unused, and kept equal to
    // the primary so a stray karaoke tag cannot make text vanish.
    style.primaryColour,
    style.outlineColour,
    style.backColour,
    style.bold ? '-1' : '0',
    '0',
    '0',
    '0',
    '100',
    '100',
    '0',
    '0',
    String(style.borderStyle),
    String(style.outlineWidth),
    String(style.shadowDepth),
    String(layout.alignment),
    String(layout.marginLeftPx),
    String(layout.marginRightPx),
    String(layout.marginVerticalPx),
    '1',
  ].join(',');

/** The cue's lines, hard-broken with `\N` and escaped for ASS. */
export const assText = (cue: SubtitleSegment): string =>
  cue.lines.map(escapeAssText).join('\\N');

/**
 * Escape ASS' own metacharacters.
 *
 * `{` opens an override block and `\` starts a tag; both are escaped so that a
 * transcript containing them is *shown*, not interpreted. Nothing is dropped —
 * dropping would edit the speaker.
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/gu, '\\\\')
    .replace(/\{/gu, '\\{')
    .replace(/\}/gu, '\\}')
    // A literal newline inside a cue line would end the Dialogue row early and
    // silently truncate the caption. Cue lines should not contain one; if one
    // survives from the transcript it becomes the hard break it reads as.
    .replace(/\r?\n/gu, '\\N');
}

/**
 * ASS timestamps: `H:MM:SS.cc`, hundredths, single-digit hour.
 *
 * Truncated rather than rounded, and clamped at zero: rounding a cue's start up
 * can put it after a previous cue's rounded end, which libass resolves by
 * dropping one of them.
 */
export function formatAssTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const centiseconds = Math.floor(total * 100);

  const cs = centiseconds % 100;
  const totalSeconds = Math.floor(centiseconds / 100);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);

  return `${hh}:${pad(mm)}:${pad(ss)}.${pad(cs)}`;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/* -------------------------------------------------------------------------- */
/* Filter                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The `subtitles` filter that burns a written `.ass` file onto the video.
 *
 * A Windows path has to survive two separate parsers, and it needs a different
 * treatment for each — quoting alone is not enough, which is the trap here:
 *
 *  1. Separators become forward slashes. FFmpeg accepts them on Windows, and it
 *     keeps backslashes — the filtergraph's escape character — out of the
 *     string entirely.
 *  2. The `:` in `C:` is escaped as `\:` *and* the whole value is quoted. The
 *     filtergraph splits a filter's arguments on `:` before the option parser
 *     ever sees the quotes, so `filename='C:/clips/a.ass'` is split mid-drive
 *     and fails with "No option name near '/clips/a.ass'". Escaping without
 *     quoting fails too, on the first space in the path.
 *
 * A literal apostrophe cannot appear inside the quotes; it is spliced in as an
 * escaped character between two quoted runs, the same rule a POSIX shell uses.
 */
export const subtitlesFilter = (assPath: string): string =>
  `subtitles=filename=${quoteFilterArgument(escapeFilterPath(assPath))}`;

/** A path as the filtergraph must read it: forward slashes, escaped colons. */
export const escapeFilterPath = (filePath: string): string =>
  filePath.replace(/\\/gu, '/').replace(/:/gu, '\\:');

export const quoteFilterArgument = (value: string): string =>
  value
    .split("'")
    .map((part) => `'${part}'`)
    .join("\\'");
