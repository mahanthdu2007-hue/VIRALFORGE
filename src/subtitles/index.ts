/**
 * Public surface of the subtitle engine. Import from `@/subtitles`.
 *
 * The engine turns a transcript and a clip's cuts into cues on the clip
 * timeline, laid out for the 9:16 safe area, and renders them as an ASS document
 * FFmpeg can burn in. It never writes, rewrites, translates or invents speech:
 * every character it emits came from the transcript.
 *
 * Nothing here touches the filesystem or spawns a process — wiring the document
 * into a render is the pipeline's job, not this module's.
 */

export {
  buildSubtitlePlan,
  areOptionsValid,
  type SubtitlePlanInput,
  type SubtitlePlanResult,
  type SubtitlePlanFailureReason,
} from './plan';

export { chunkWordsIntoCues, layoutLines, endsSentence, type ChunkConfig } from './chunk';

export {
  renderAssDocument,
  subtitlesFilter,
  quoteFilterArgument,
  escapeFilterPath,
  escapeAssText,
  formatAssTime,
  assText,
  DEFAULT_SUBTITLE_STYLE,
  type SubtitleStyle,
} from './ass';

export { buildClipTimeline, mapRangeToClip, rangeSurvivesCuts, type ClipTimeline } from './timeline';

export {
  collectClipWords,
  apportionSegment,
  alignSegmentWords,
  wordsSpellSegmentText,
  type CollectedWords,
  type AlignedWord,
} from './words';
