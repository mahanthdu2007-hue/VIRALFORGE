/**
 * Composition root.
 *
 * The single place where concrete implementations are chosen and wired. Route
 * handlers ask for the runtime; everything they get back is an interface.
 *
 * Cached on `globalThis` because the Next dev server re-evaluates modules on hot
 * reload, and a second SQLite handle plus a second job runner per edit would be
 * a genuine correctness problem, not just waste.
 */

import { getConfig, type AppConfig } from '@/config/env';
import { createLogger, type Logger } from '@/lib/logger';
import { openDatabase, type Database } from '@/storage/db';
import { LocalFileStore, type FileStore } from '@/storage/file-store';
import { SqliteVideoRepository, type VideoRepository } from '@/storage/video-repository';
import { SqliteTranscriptRepository, type TranscriptRepository } from '@/storage/transcript-repository';
import { SqliteCandidateRepository, type CandidateRepository } from '@/storage/candidate-repository';
import { SqliteClipPlanRepository, type ClipPlanRepository } from '@/storage/clip-plan-repository';
import { SqliteClipRenderRepository, type ClipRenderRepository } from '@/storage/clip-render-repository';
import { SqliteJobStore, type JobStore } from '@/jobs/store';
import { JobRunner, recoverInterrupted, resumeQueued } from '@/jobs/runner';
import { FfmpegMediaService, type MediaService } from '@/media/media-service';
import { FfmpegFrameSource } from '@/media/frame-source';
import { resolveProvider } from '@/ai/registry';
import { runAnalysis } from '@/pipeline/analysis';
import type { AnalysisDeps } from '@/pipeline/deps';
import { renderClipPlan, type RenderClipPlanRequest, type RenderClipPlanResult } from '@/pipeline/render-clip';
import type { AiProvider } from '@/ai/types';
import type { AnalysisJob, Dimensions } from '@/domain';

export interface Runtime {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: Database;
  readonly files: FileStore;
  readonly videos: VideoRepository;
  readonly transcripts: TranscriptRepository;
  readonly candidates: CandidateRepository;
  readonly clipPlans: ClipPlanRepository;
  readonly clipRenders: ClipRenderRepository;
  readonly jobs: JobStore;
  readonly media: MediaService;
  readonly runner: JobRunner;
  /** Lazy: an unimplemented or unconfigured provider must not break startup. */
  aiProvider(): AiProvider;
  /** ClipPlan → tracked/fallback crop → rendered 9:16 file. See `@/pipeline/render-clip`. */
  renderClip(request: RenderClipPlanRequest): Promise<RenderClipPlanResult>;
}

function build(): Runtime {
  const config = getConfig();
  const logger = createLogger({ level: config.logLevel, name: 'viralforge' });
  const files = new LocalFileStore(config.storage.rootDir);
  const db = openDatabase(config.storage.databasePath);

  const videos = new SqliteVideoRepository(db);
  const transcripts = new SqliteTranscriptRepository(db);
  const candidates = new SqliteCandidateRepository(db);
  const clipPlans = new SqliteClipPlanRepository(db);
  const clipRenders = new SqliteClipRenderRepository(db);
  const jobs = new SqliteJobStore(db);
  const media = new FfmpegMediaService({
    ffmpegPath: config.media.ffmpegPath,
    ffprobePath: config.media.ffprobePath,
  });

  const aiProvider = () => resolveProvider(config);

  const renderClip = (request: RenderClipPlanRequest) =>
    renderClipPlan(
      {
        ffmpegPath: config.media.ffmpegPath,
        ffprobePath: config.media.ffprobePath,
        media,
        tracking: config.tracking,
        frameSource: (source: Dimensions) =>
          new FfmpegFrameSource({ ffmpegPath: config.media.ffmpegPath, source }),
        logger,
      },
      request,
    );

  const runner = new JobRunner({
    concurrency: config.jobs.concurrency,
    logger,
    jobs,
    run: (job: AnalysisJob) => {
      // Resolved per job so a configuration fix takes effect without a restart,
      // and so a broken provider fails the job rather than the process.
      const deps: AnalysisDeps = {
        logger,
        jobs,
        videos,
        transcripts,
        candidates,
        clipPlans,
        files,
        media,
        provider: aiProvider(),
        maxCandidates: config.jobs.maxCandidates,
        // Turns the render stage on: the analysis run finishes with real 9:16
        // files rather than plans. Rendering is sequential inside the stage,
        // and `JOB_CONCURRENCY` bounds how many jobs reach it at once.
        renders: clipRenders,
        renderClip,
      };
      return runAnalysis(deps, job);
    },
  });

  void files.init().catch((error: unknown) => {
    logger.error('storage initialisation failed', error, { root: config.storage.rootDir });
  });

  // Jobs that a previous process left mid-flight cannot be resumed; jobs that
  // never started can. Both are handled before the first request arrives.
  void recoverInterrupted(jobs, logger)
    .then(() => resumeQueued(jobs, runner, logger))
    .catch((error: unknown) => logger.error('job recovery failed', error));

  logger.info('runtime ready', {
    provider: config.ai.provider,
    database: config.storage.databasePath,
    concurrency: config.jobs.concurrency,
  });

  return {
    config,
    logger,
    db,
    files,
    videos,
    transcripts,
    candidates,
    clipPlans,
    clipRenders,
    jobs,
    media,
    runner,
    aiProvider,
    renderClip,
  };
}

const globalRef = globalThis as typeof globalThis & { __viralforgeRuntime?: Runtime };

export function getRuntime(): Runtime {
  globalRef.__viralforgeRuntime ??= build();
  return globalRef.__viralforgeRuntime;
}
