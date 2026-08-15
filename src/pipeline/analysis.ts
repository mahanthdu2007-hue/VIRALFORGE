/**
 * Analysis pipeline.
 *
 * ANALYZING → TRANSCRIBING → FINDING_CLIPS → BUILDING_CLIPS → RENDERING →
 * COMPLETED, driven through the existing state machine. Each stage persists its
 * result before the next begins, so a crash leaves the job's true position
 * visible rather than a silent gap.
 *
 * The render stage is conditional, not optional-by-accident: it runs when the
 * caller supplied somewhere to record renders and something to render with (see
 * `AnalysisDeps`), and is skipped otherwise, leaving the run finishing at clip
 * selection exactly as it did before. A job that renders nothing still
 * completes — the Shorts it planned are the deliverable of the earlier stages.
 *
 * Memory: the video is only ever a path handed to FFmpeg, and the extracted
 * audio is a file the provider streams. The transcript is the largest object
 * this function holds, and it is text. No video is decoded in this module —
 * decoding happens inside the FFmpeg processes the render stage runs one at a
 * time, never several at once.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  CANDIDATE_MAX_DURATION_SEC,
  CANDIDATE_MIN_DURATION_SEC,
  type AnalysisJob,
  type CandidateClip,
  type ClipPlan,
  type ClipRender,
  type Transcript,
  type VideoAsset,
} from '@/domain';
import { mediaError, processingError, toAppError } from '@/lib/errors';
import { optionalClipRefinement, requireClipDiscovery, requireTranscription } from '@/ai/registry';
import { AUDIO_FILE_EXTENSION, DEFAULT_AUDIO_SPEC } from '@/media/audio';
import { normaliseTranscriptDraft } from '@/validation/transcript';
import { validateCandidates } from '@/validation/candidates';
import { validateClipPlans } from '@/validation/clip-plans';
import {
  ClipConstruction,
  preselectCandidates,
  scoreClip,
  selectTopClips,
  type ScoredClipPlan,
} from '@/clips';
import { buildTranscript } from '@/storage/transcript-repository';
import { buildCandidates } from '@/storage/candidate-repository';
import { buildClipPlans } from '@/storage/clip-plan-repository';
import { failJob, setJobProgress, transitionJob } from '@/jobs/transitions';
import { renderSelectedClips } from './render-stage';
import type { AnalysisDeps } from './deps';

/**
 * Default ceiling on clips built per run.
 *
 * Construction makes one refinement call per clip, so this — not the discovery
 * limit — is what bounds a run's cost. Twelve is comfortably more than the three
 * that get selected, which leaves ranking a real choice to make.
 */
export const MAX_CLIPS_TO_BUILD = 12;

export interface AnalysisOutcome {
  readonly job: AnalysisJob;
  readonly transcript: Transcript | null;
  readonly candidates: readonly CandidateClip[];
  readonly rejectedCandidates: number;
  /** The selected Shorts, best first. Empty when nothing survived. */
  readonly clipPlans: readonly ClipPlan[];
  readonly rejectedClipPlans: number;
  /** One per clip the render stage attempted. Empty when it did not run. */
  readonly renders: readonly ClipRender[];
}

/**
 * Run one analysis job to completion.
 *
 * Never throws for a pipeline failure: the job is moved to FAILED with the
 * reason recorded, because the job record is how the caller learns what
 * happened. Only a failure to persist that outcome propagates.
 */
export async function runAnalysis(deps: AnalysisDeps, job: AnalysisJob): Promise<AnalysisOutcome> {
  const log = deps.logger.child({ jobId: job.id, videoId: job.videoId });
  let audioPath: string | null = null;
  let current = job;

  try {
    /* -- Analyze ---------------------------------------------------------- */
    current = await save(deps, transitionJob(current, 'ANALYZING', { note: 'probing source' }));

    const video = await deps.videos.get(current.videoId);
    const metadata = await ensureMetadata(deps, video);
    if (!metadata.hasAudio) {
      throw mediaError('no_audio_stream', 'The video has no audio track, so it cannot be transcribed.');
    }

    const transcription = requireTranscription(deps.provider);
    const discovery = requireClipDiscovery(deps.provider);
    const spec = transcription.audioSpec ?? DEFAULT_AUDIO_SPEC;

    audioPath = deps.files.absolutePath(
      `work/${current.videoId}${AUDIO_FILE_EXTENSION[spec.format]}`,
    );

    const audio = await deps.media.extractAudio(
      deps.files.absolutePath(video.storageKey),
      audioPath,
      spec,
    );
    log.info('audio extracted', {
      sizeBytes: audio.sizeBytes,
      format: spec.format,
      sampleRateHz: spec.sampleRateHz,
    });

    if (spec.maxBytes !== undefined && audio.sizeBytes > spec.maxBytes) {
      throw processingError('audio_too_large', 'Extracted audio exceeds the provider upload limit.', {
        details: { sizeBytes: audio.sizeBytes, maxBytes: spec.maxBytes },
      });
    }

    /* -- Transcribe ------------------------------------------------------- */
    current = await save(deps, transitionJob(current, 'TRANSCRIBING'));

    const draft = await transcription.transcribe({
      audioPath: audio.path,
      durationSec: metadata.durationSec,
    });

    const normalised = normaliseTranscriptDraft(draft, metadata.durationSec);
    if (normalised.notes.length > 0) {
      log.debug('transcript normalised', { notes: normalised.notes });
    }

    const transcript = await deps.transcripts.save(
      buildTranscript(normalised, current.videoId, deps.provider.id, deps.newId),
    );
    log.info('transcript persisted', {
      transcriptId: transcript.id,
      segments: transcript.segments.length,
      language: transcript.language,
    });

    current = await save(deps, {
      ...setJobProgress(current, 50),
      result: { ...current.result, transcriptId: transcript.id },
    });

    /* -- Discover --------------------------------------------------------- */
    current = await save(deps, transitionJob(current, 'FINDING_CLIPS'));

    const drafts = await discovery.discoverClips({
      segments: transcript.segments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text })),
      videoDurationSec: metadata.durationSec,
      maxCandidates: deps.maxCandidates,
      targetDurationSec: { min: CANDIDATE_MIN_DURATION_SEC, max: CANDIDATE_MAX_DURATION_SEC },
      ...(transcript.language ? { languageHint: transcript.language } : {}),
    });

    const { accepted, rejected } = validateCandidates(drafts, transcript, metadata.durationSec);
    for (const rejection of rejected) {
      // Rejections are the audit trail for the verbatim guarantee, so each one
      // is logged individually rather than counted.
      log.warn('candidate rejected', { code: rejection.code, reason: rejection.reason, range: rejection.range });
    }

    const candidates = await deps.candidates.saveMany(
      buildCandidates(accepted, current.videoId, transcript.id, deps.newId),
      transcript.id,
    );
    log.info('candidates persisted', { accepted: candidates.length, rejected: rejected.length });

    /* -- Build clips ------------------------------------------------------ */
    current = await save(deps, transitionJob(current, 'BUILDING_CLIPS'));

    const construction = new ClipConstruction(transcript, metadata.durationSec, {
      // Optional by design: a provider that cannot read clips costs some scoring
      // nuance, not the stage.
      refinement: optionalClipRefinement(deps.provider),
      logger: log,
    });

    const toBuild = boundCandidates(candidates, deps.maxClipsToBuild ?? MAX_CLIPS_TO_BUILD);
    if (toBuild.length < candidates.length) {
      log.info('candidates preselected', {
        found: candidates.length,
        building: toBuild.length,
        skipped: candidates.map((c) => c.id).filter((id) => !toBuild.some((c) => c.id === id)),
      });
    }

    const planDrafts = await construction.constructAll(toBuild);

    const planCheck = validateClipPlans(planDrafts, metadata.durationSec);
    for (const rejection of planCheck.rejected) {
      // Same reasoning as candidates: each rejection is part of the audit trail
      // for the verbatim guarantee, so it is logged individually.
      log.warn('clip plan rejected', {
        code: rejection.code,
        reason: rejection.reason,
        candidateClipId: rejection.candidateClipId,
        range: rejection.range,
      });
    }

    const scored: ScoredClipPlan[] = planCheck.accepted.map((draft) => ({
      draft,
      score: scoreClip({
        text: draft.text,
        durationSec: draft.durationSec,
        signals: draft.signals,
        boundaries: draft.boundaries,
        speech: draft.speech,
        hookQuote: draft.hookQuote,
        semantic: draft.semantic,
      }),
    }));

    const selection = selectTopClips(scored, {
      ...(deps.maxSelectedClips === undefined ? {} : { maxSelected: deps.maxSelectedClips }),
    });
    for (const rejection of selection.rejected) {
      log.debug('clip not selected', { code: rejection.code, reason: rejection.reason });
    }

    const clipPlans = await deps.clipPlans.saveMany(
      buildClipPlans(selection.selected, deps.newId),
      transcript.id,
    );
    log.info('clip plans persisted', {
      built: planDrafts.length,
      rejected: planCheck.rejected.length,
      selected: clipPlans.length,
    });

    current = await save(deps, {
      ...current,
      result: {
        ...current.result,
        candidateClipIds: candidates.map((c) => c.id),
        selectedClipPlanIds: clipPlans.map((p) => p.id),
      },
    });

    /* -- Render ----------------------------------------------------------- */
    let renders: readonly ClipRender[] = [];

    if (deps.renders && deps.renderClip && clipPlans.length > 0) {
      current = await save(deps, transitionJob(current, 'RENDERING'));

      // Sequential inside the stage; the job's progress is nudged after each
      // clip so a three-clip render is not a five-minute silence in the UI.
      const renderingFloor = current.progress;
      renders = await renderSelectedClips(
        {
          logger: log,
          files: deps.files,
          renders: deps.renders,
          renderClip: deps.renderClip,
          ...(deps.newId ? { newId: deps.newId } : {}),
        },
        {
          video: video.metadata ? video : { ...video, metadata },
          transcript,
          plans: clipPlans,
          onProgress: async (done, total) => {
            const span = 99 - renderingFloor;
            current = await save(deps, setJobProgress(current, renderingFloor + (span * done) / total));
          },
        },
      );

      current = await save(deps, {
        ...current,
        result: { ...current.result, renderIds: renders.map((r) => r.id) },
      });
    }

    /* -- Complete --------------------------------------------------------- */
    const renderedCount = renders.filter((r) => r.status === 'RENDERED').length;
    current = await save(deps, {
      ...transitionJob(current, 'COMPLETED', {
        note:
          `${candidates.length} candidates, ${clipPlans.length} clips` +
          (renders.length > 0 ? `, ${renderedCount}/${renders.length} rendered` : ''),
      }),
      result: {
        transcriptId: transcript.id,
        candidateClipIds: candidates.map((c) => c.id),
        selectedClipPlanIds: clipPlans.map((p) => p.id),
        renderIds: renders.map((r) => r.id),
      },
    });

    return {
      job: current,
      transcript,
      candidates,
      rejectedCandidates: rejected.length,
      clipPlans,
      rejectedClipPlans: planCheck.rejected.length,
      renders,
    };
  } catch (error) {
    const app = toAppError(error);
    log.error('analysis failed', error, { state: current.state });
    const failed = await save(deps, failJob(current, app));
    return {
      job: failed,
      transcript: null,
      candidates: [],
      rejectedCandidates: 0,
      clipPlans: [],
      rejectedClipPlans: 0,
      renders: [],
    };
  } finally {
    // The audio is an intermediate: it is reproducible from the source video and
    // has no value once the transcript exists.
    const workFile = audioPath;
    if (workFile) {
      await fsp.rm(workFile, { force: true }).catch((error: unknown) => {
        log.warn('could not remove work audio', { file: path.basename(workFile), error: String(error) });
      });
    }
  }
}

/**
 * The candidates worth spending a refinement call on.
 *
 * Discovery may return more moments than a run should build, and confidence
 * alone is a poor way to choose between them: a channel intro reads as a very
 * confident moment while the video's best hook can arrive unsure of where it
 * ends. So the cut blends confidence with a free reading of the candidate's own
 * text — see `preselectCandidates`, which owns the reasoning. Ranking still
 * decides the final three from whatever survives.
 */
export function boundCandidates(
  candidates: readonly CandidateClip[],
  limit: number,
): readonly CandidateClip[] {
  return preselectCandidates(candidates, limit);
}

/** Probes on demand if the record predates metadata capture. */
async function ensureMetadata(deps: AnalysisDeps, video: VideoAsset) {
  if (video.metadata) return video.metadata;

  const metadata = await deps.media.probe(deps.files.absolutePath(video.storageKey));
  await deps.videos.save({ ...video, metadata });
  return metadata;
}

const save = (deps: AnalysisDeps, job: AnalysisJob): Promise<AnalysisJob> => deps.jobs.save(job);
