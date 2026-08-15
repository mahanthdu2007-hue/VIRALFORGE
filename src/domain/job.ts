import type { Brand, IsoTimestamp } from './common';
import type { JobState } from './job-state';
import type { VideoId } from './video';
import type { TranscriptId } from './transcript';
import type { CandidateClipId, ClipPlanId } from './clip';
import type { ClipRenderId } from './render';
import type { ErrorKind } from '@/lib/errors';

export type JobId = Brand<string, 'JobId'>;

export type JobType = 'analysis' | 'render';

/** Serialisable failure record stored on a job. Mirrors `AppError.toJSON()`. */
export interface JobFailure {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly message: string;
  readonly at: IsoTimestamp;
}

/** Append-only audit trail of state changes. */
export interface JobEvent {
  readonly state: JobState;
  readonly at: IsoTimestamp;
  readonly note: string | null;
}

/** Fields every job carries, regardless of type. */
export interface JobBase {
  readonly id: JobId;
  readonly type: JobType;
  readonly state: JobState;
  /** 0..100. Monotonic within a job. */
  readonly progress: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly startedAt: IsoTimestamp | null;
  readonly finishedAt: IsoTimestamp | null;
  readonly failure: JobFailure | null;
  readonly history: readonly JobEvent[];
}

/** What an analysis run produces. Populated incrementally as stages finish. */
export interface AnalysisResult {
  readonly transcriptId: TranscriptId | null;
  readonly candidateClipIds: readonly CandidateClipId[];
  /** The best 3, ranked. */
  readonly selectedClipPlanIds: readonly ClipPlanId[];
  /**
   * One per selected clip the render stage attempted, successes and failures
   * alike, in the order they were rendered. Empty when the run stopped at
   * clip building — the render stage is only wired in when the runtime can
   * actually render.
   */
  readonly renderIds: readonly ClipRenderId[];
}

/**
 * Drives one source video from upload through to a set of ClipPlans.
 * Covers ANALYZING → TRANSCRIBING → FINDING_CLIPS → BUILDING_CLIPS.
 */
export interface AnalysisJob extends JobBase {
  readonly type: 'analysis';
  readonly videoId: VideoId;
  readonly result: AnalysisResult;
}

/** Encodes exactly one ClipPlan into a deliverable file. */
export interface RenderJob extends JobBase {
  readonly type: 'render';
  readonly videoId: VideoId;
  readonly clipPlanId: ClipPlanId;
  readonly result: RenderResult | null;
}

/** The rendered artefact. Bytes live on disk under `storageKey`. */
export interface RenderResult {
  readonly clipPlanId: ClipPlanId;
  readonly storageKey: string;
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly sizeBytes: number;
  readonly createdAt: IsoTimestamp;
}

export type Job = AnalysisJob | RenderJob;

export const isAnalysisJob = (job: Job): job is AnalysisJob => job.type === 'analysis';
export const isRenderJob = (job: Job): job is RenderJob => job.type === 'render';
