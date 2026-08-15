import type { Brand, IsoTimestamp, TimeRange } from './common';
import type { VideoId } from './video';

export type TranscriptId = Brand<string, 'TranscriptId'>;
export type TranscriptSegmentId = Brand<string, 'TranscriptSegmentId'>;

/**
 * A single timed word. Present only when the provider reports word-level
 * granularity; the interface stays optional so a segment-only provider is still
 * a first-class citizen.
 */
export interface TranscriptWord extends TimeRange {
  readonly text: string;
}

/**
 * One timed unit of speech from the source audio.
 *
 * `text` is always verbatim: ViralForge never rewrites what the speaker said.
 */
export interface TranscriptSegment extends TimeRange {
  readonly id: TranscriptSegmentId;
  /** Position in the transcript, ascending and gap-free. */
  readonly index: number;
  readonly text: string;
  /** Provider-reported confidence, 0..1, when available. */
  readonly confidence: number | null;
  /** Diarisation label such as `SPEAKER_00`, when the provider supplies one. */
  readonly speaker: string | null;
  /** Null when the provider offers no word-level timing. */
  readonly words: readonly TranscriptWord[] | null;
}

export interface Transcript {
  readonly id: TranscriptId;
  readonly videoId: VideoId;
  /** BCP-47 tag, e.g. `en`, or null when detection was inconclusive. */
  readonly language: string | null;
  /** Which provider + model produced this, for reproducibility. */
  readonly source: { readonly provider: string; readonly model: string };
  readonly segments: readonly TranscriptSegment[];
  readonly createdAt: IsoTimestamp;
}

/** Concatenated verbatim text, for prompts and search. */
export const transcriptText = (transcript: Transcript): string =>
  transcript.segments.map((s) => s.text.trim()).join(' ');

/** Verbatim text of every segment that intersects the given range, in order. */
export function textInRange(transcript: Transcript, range: TimeRange): string {
  return transcript.segments
    .filter((s) => s.startSec < range.endSec && s.endSec > range.startSec)
    .map((s) => s.text.trim())
    .join(' ')
    .trim();
}

/** Whether any segment carries word-level timing. */
export const hasWordTimings = (transcript: Transcript): boolean =>
  transcript.segments.some((s) => s.words !== null && s.words.length > 0);
