/**
 * What the analysis pipeline needs.
 *
 * Declared as a plain bag of interfaces rather than reaching for the runtime, so
 * a test can assemble a pipeline from an in-memory database and a stub provider
 * without a server, a filesystem root, or an API key.
 */

import type { IdFactory } from '@/domain';
import type { Logger } from '@/lib/logger';
import type { AiProvider } from '@/ai/types';
import type { MediaService } from '@/media/media-service';
import type { FileStore } from '@/storage/file-store';
import type { VideoRepository } from '@/storage/video-repository';
import type { TranscriptRepository } from '@/storage/transcript-repository';
import type { CandidateRepository } from '@/storage/candidate-repository';
import type { ClipPlanRepository } from '@/storage/clip-plan-repository';
import type { ClipRenderRepository } from '@/storage/clip-render-repository';
import type { JobStore } from '@/jobs/store';
import type { RenderClipFn } from './render-stage';

export interface AnalysisDeps {
  readonly logger: Logger;
  readonly jobs: JobStore;
  readonly videos: VideoRepository;
  readonly transcripts: TranscriptRepository;
  readonly candidates: CandidateRepository;
  readonly clipPlans: ClipPlanRepository;
  readonly files: FileStore;
  readonly media: MediaService;
  readonly provider: AiProvider;
  readonly maxCandidates: number;
  /**
   * Ceiling on how many candidates are built into clips. Construction is one
   * provider call per clip, so this bounds the cost of a run independently of
   * how many moments discovery returned. Defaults to `MAX_CLIPS_TO_BUILD`.
   */
  readonly maxClipsToBuild?: number;
  /** How many Shorts to select. Defaults to the ranking module's target of 3. */
  readonly maxSelectedClips?: number;
  /**
   * Where render outcomes are recorded, and what does the rendering.
   *
   * Both optional and both required together: a deployment without a working
   * toolchain — or a test that only cares about clip selection — runs the
   * analysis exactly as before and stops at BUILDING_CLIPS. Supplying them is
   * what turns the render stage on.
   */
  readonly renders?: ClipRenderRepository;
  readonly renderClip?: RenderClipFn;
  /** Injectable so tests can assert on stable identifiers. */
  readonly newId?: IdFactory;
}
