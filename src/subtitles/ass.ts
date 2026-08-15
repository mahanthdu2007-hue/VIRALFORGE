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
    ...plan.segments.map(dialogueRow),
  ];

  return `${lines.join('\n')}\n`;
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

const dialogueRow = (cue: SubtitleSegment): string =>
  `Dialogue: 0,${formatAssTime(cue.startSec)},${formatAssTime(cue.endSec)},${STYLE_NAME},,0,0,0,,${assText(cue)}`;

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
