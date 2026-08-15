/**
 * Transcript + cuts → a `SubtitlePlan`.
 *
 * The seam of the subtitle engine: everything below it is pure geometry, timing
 * or string work, and this module is where those meet. Its whole job is four
 * steps in a fixed order — resolve the layout, map the words onto the clip,
 * chunk them into cues, then *validate the result and refuse to return a plan
 * that fails*. The last step is the point. A plan handed back from here is one
 * the renderer can burn without re-checking.
 *
 * One decision worth stating: **cues never span a cut**. Words are grouped per
 * cut and chunked independently, so a caption can't run across a join the viewer
 * hears as a jump — and, less visibly, every cue stays contiguous speech in the
 * *source*, which is what makes `verifySubtitleFidelity` a meaningful check
 * rather than one that flags honest plans at every join.
 *
 * Reads the transcript and nothing else: no media, no clock, no model.
 */

import {
  DEFAULT_SUBTITLE_OPTIONS,
  planSubtitleLayout,
  validateSubtitleSegments,
  type ClipCut,
  type SubtitleIssue,
  type SubtitleLayout,
  type SubtitleLayoutConfig,
  type SubtitleLayoutFailureReason,
  type SubtitleOptions,
  type SubtitlePlan,
  type SubtitleSegment,
  type SubtitleSourceWord,
  type TranscriptSegment,
} from '@/domain';
import { chunkWordsIntoCues } from './chunk';
import { buildClipTimeline, type ClipTimeline } from './timeline';
import { collectClipWords } from './words';

export interface SubtitlePlanInput {
  /** The Short's cuts, on the source timeline. Normally `ClipPlan.cuts`. */
  readonly cuts: readonly ClipCut[];
  /** Transcript segments to draw from. Segments outside the cuts are ignored. */
  readonly segments: readonly TranscriptSegment[];
  /** Overrides on the reading constraints; unset fields keep the defaults. */
  readonly options?: Partial<SubtitleOptions>;
  readonly layout?: SubtitleLayoutConfig;
}

export type SubtitlePlanFailureReason =
  | SubtitleLayoutFailureReason
  | 'empty_clip'
  | 'invalid_options'
  | 'invalid_cues';

export type SubtitlePlanResult =
  | { readonly ok: true; readonly plan: SubtitlePlan }
  | {
      readonly ok: false;
      readonly reason: SubtitlePlanFailureReason;
      /** Present when the failure is `invalid_cues`. */
      readonly issues?: readonly SubtitleIssue[];
    };

/**
 * Build the plan, or say why one cannot be built.
 *
 * A clip with no speech is a success with no cues, not a failure: silent
 * B-roll is a legitimate Short, and refusing it here would push a decision
 * about content into a module that only knows about timing.
 */
export function buildSubtitlePlan(input: SubtitlePlanInput): SubtitlePlanResult {
  const timeline = buildClipTimeline(input.cuts);
  if (timeline.durationSec <= 0) return { ok: false, reason: 'empty_clip' };

  const requested: SubtitleOptions = { ...DEFAULT_SUBTITLE_OPTIONS, ...input.options };
  if (!areOptionsValid(requested)) return { ok: false, reason: 'invalid_options' };

  // The layout is resolved first because it answers a question the chunker
  // needs: how many characters actually fit on a line at this frame size. That
  // is geometry, not taste, which is why the option defaults to null.
  const layoutResult = planSubtitleLayout({
    ...input.layout,
    maxLines: input.layout?.maxLines ?? requested.maxLines,
  });
  if (!layoutResult.ok) return { ok: false, reason: layoutResult.reason };

  const layout = layoutResult.layout;
  const options: SubtitleOptions = {
    ...requested,
    maxCharsPerLine: requested.maxCharsPerLine ?? layout.maxCharsPerLine,
    maxLines: layout.maxLines,
  };

  const collected = collectClipWords(input.segments, timeline);
  const segments = chunkPerCut(collected.words, timeline, options, layout);

  const notes = [...collected.notes, ...layout.notes];
  if (segments.length === 0) notes.push('no_cues');

  const issues = validateSubtitleSegments(segments, timeline.durationSec, options);
  if (issues.length > 0) return { ok: false, reason: 'invalid_cues', issues };

  return {
    ok: true,
    plan: {
      clipDurationSec: timeline.durationSec,
      segments,
      layout,
      options,
      notes: [...new Set(notes)],
    },
  };
}

/**
 * Chunk each cut's words separately, numbering the cues continuously.
 *
 * Splitting on `offsets` is exact rather than approximate: `mapRangeToClip`
 * assigns a straddling word to a single cut, so every word lands strictly inside
 * one half-open `[offset, offset + length)` window.
 */
function chunkPerCut(
  words: readonly SubtitleSourceWord[],
  timeline: ClipTimeline,
  options: SubtitleOptions,
  layout: SubtitleLayout,
): SubtitleSegment[] {
  const maxCharsPerLine = options.maxCharsPerLine ?? layout.maxCharsPerLine;
  const cues: SubtitleSegment[] = [];

  for (const [index, cut] of timeline.cuts.entries()) {
    const from = timeline.offsets[index]!;
    const to = from + (cut.endSec - cut.startSec);
    const inCut = words.filter((word) => word.startSec >= from && word.startSec < to);
    if (inCut.length === 0) continue;

    cues.push(
      ...chunkWordsIntoCues(inCut, {
        options,
        maxCharsPerLine,
        // The cue after the last one in a cut must not bleed into the next cut's
        // first word, so the ceiling for the minimum-duration stretch is this
        // cut's end, not the whole clip's.
        clipDurationSec: to,
        startIndex: cues.length,
      }),
    );
  }

  return cues;
}

/**
 * Reject a configuration that cannot produce a readable caption.
 *
 * These are contradictions, not preferences: a minimum longer than the maximum,
 * a cue of zero words, a line of zero characters. Each would otherwise surface
 * as a confusing cue list rather than as a configuration error.
 */
export function areOptionsValid(options: SubtitleOptions): boolean {
  const positiveInts = [options.maxWordsPerCaption, options.maxLines];
  if (positiveInts.some((value) => !Number.isInteger(value) || value < 1)) return false;

  if (!Number.isInteger(options.breakOnClauseAfterWords) || options.breakOnClauseAfterWords < 0) {
    return false;
  }

  const durations = [options.maxDurationSec, options.minDurationSec, options.breakOnPauseSec];
  if (durations.some((value) => !Number.isFinite(value) || value < 0)) return false;
  if (options.maxDurationSec <= 0) return false;
  if (options.minDurationSec > options.maxDurationSec) return false;

  if (options.maxCharsPerLine !== null) {
    if (!Number.isInteger(options.maxCharsPerLine) || options.maxCharsPerLine < 1) return false;
  }

  return true;
}
