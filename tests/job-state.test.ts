import { beforeEach, describe, expect, it } from 'vitest';
import {
  canTransition,
  isJobState,
  isTerminalJobState,
  JOB_STATES,
  JOB_STATE_LABELS,
  JOB_STATE_PROGRESS,
  JOB_TRANSITIONS,
  TERMINAL_JOB_STATES,
  type JobId,
  type JobState,
} from '@/domain';
import { cancelJob, failJob, setJobProgress, transitionJob } from '@/jobs/transitions';
import { createAnalysisJob, createRenderJob, SqliteJobStore } from '@/jobs/store';
import { SqliteVideoRepository } from '@/storage/video-repository';
import { openDatabase } from '@/storage/db';
import { isAppError, mediaError } from '@/lib/errors';
import { makeVideoAsset, VIDEO_ID } from './helpers/fixtures';
import type { ClipPlanId } from '@/domain';

const HAPPY_PATH: readonly JobState[] = [
  'QUEUED',
  'UPLOADING',
  'ANALYZING',
  'TRANSCRIBING',
  'FINDING_CLIPS',
  'BUILDING_CLIPS',
  'RENDERING',
  'COMPLETED',
];

describe('job state definitions', () => {
  it('declares exactly the required states', () => {
    expect(JOB_STATES).toEqual([
      'QUEUED',
      'UPLOADING',
      'ANALYZING',
      'TRANSCRIBING',
      'FINDING_CLIPS',
      'BUILDING_CLIPS',
      'RENDERING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
    ]);
  });

  it('has a label and a progress floor for every state', () => {
    for (const state of JOB_STATES) {
      expect(JOB_STATE_LABELS[state]).toBeTruthy();
      expect(JOB_STATE_PROGRESS[state]).toBeGreaterThanOrEqual(0);
      expect(JOB_STATE_PROGRESS[state]).toBeLessThanOrEqual(100);
    }
  });

  it('leaves terminal states with no successors', () => {
    for (const state of TERMINAL_JOB_STATES) {
      expect(JOB_TRANSITIONS[state]).toEqual([]);
      expect(isTerminalJobState(state)).toBe(true);
    }
  });

  it('lets every non-terminal state fail or cancel', () => {
    for (const state of JOB_STATES.filter((s) => !isTerminalJobState(s))) {
      expect(canTransition(state, 'FAILED')).toBe(true);
      expect(canTransition(state, 'CANCELLED')).toBe(true);
    }
  });

  it('allows the full happy path, step by step', () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i += 1) {
      expect(canTransition(HAPPY_PATH[i]!, HAPPY_PATH[i + 1]!)).toBe(true);
    }
  });

  it('lets a discovery-only analysis complete after FINDING_CLIPS', () => {
    // Phase 2 ends at persisted candidates; construction is a separate stage.
    expect(canTransition('FINDING_CLIPS', 'COMPLETED')).toBe(true);
    expect(canTransition('FINDING_CLIPS', 'BUILDING_CLIPS')).toBe(true);
  });

  it('forbids skipping a stage or moving backwards', () => {
    expect(canTransition('ANALYZING', 'FINDING_CLIPS')).toBe(false);
    expect(canTransition('TRANSCRIBING', 'ANALYZING')).toBe(false);
    expect(canTransition('COMPLETED', 'RENDERING')).toBe(false);
  });

  it('never names a state outside the enum as a successor', () => {
    for (const successors of Object.values(JOB_TRANSITIONS)) {
      for (const state of successors) expect(isJobState(state)).toBe(true);
    }
  });

  it('guards against unknown state strings', () => {
    expect(isJobState('PROCESSING')).toBe(false);
    expect(isJobState(undefined)).toBe(false);
  });
});

describe('transitionJob', () => {
  it('records history and raises the progress floor', () => {
    const job = createAnalysisJob(VIDEO_ID);
    const analyzing = transitionJob(transitionJob(job, 'UPLOADING'), 'ANALYZING', { note: 'probing' });

    expect(analyzing.state).toBe('ANALYZING');
    expect(analyzing.progress).toBe(JOB_STATE_PROGRESS.ANALYZING);
    expect(analyzing.history.map((h) => h.state)).toEqual(['QUEUED', 'UPLOADING', 'ANALYZING']);
    expect(analyzing.history.at(-1)!.note).toBe('probing');
    expect(analyzing.startedAt).not.toBeNull();
    expect(analyzing.finishedAt).toBeNull();
  });

  it('does not mutate the input job', () => {
    const job = createAnalysisJob(VIDEO_ID);
    transitionJob(job, 'UPLOADING');
    expect(job.state).toBe('QUEUED');
    expect(job.history).toHaveLength(1);
  });

  it('stamps finishedAt on a terminal state', () => {
    const job = transitionJob(createAnalysisJob(VIDEO_ID), 'CANCELLED');
    expect(job.finishedAt).not.toBeNull();
    expect(job.progress).toBe(100);
  });

  it('throws a processing error on an illegal transition', () => {
    try {
      transitionJob(createAnalysisJob(VIDEO_ID), 'COMPLETED');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return;
      expect(error.kind).toBe('processing');
      expect(error.code).toBe('illegal_job_transition');
      expect(error.details).toMatchObject({ from: 'QUEUED', to: 'COMPLETED' });
    }
  });
});

describe('setJobProgress', () => {
  it('advances progress but never rewinds it', () => {
    const job = transitionJob(createAnalysisJob(VIDEO_ID), 'ANALYZING');
    expect(setJobProgress(job, 20).progress).toBe(20);
    expect(setJobProgress(job, 5).progress).toBe(JOB_STATE_PROGRESS.ANALYZING);
  });

  it('clamps out-of-range values', () => {
    const job = transitionJob(createAnalysisJob(VIDEO_ID), 'ANALYZING');
    expect(setJobProgress(job, 5000).progress).toBe(100);
    expect(setJobProgress(job, Number.NaN).progress).toBe(JOB_STATE_PROGRESS.ANALYZING);
  });
});

describe('failJob / cancelJob', () => {
  it('captures the error kind and code on the job', () => {
    const failed = failJob(transitionJob(createAnalysisJob(VIDEO_ID), 'ANALYZING'), mediaError('no_video_stream', 'No video.'));

    expect(failed.state).toBe('FAILED');
    expect(failed.failure).toMatchObject({ kind: 'media', code: 'no_video_stream', message: 'No video.' });
    expect(failed.finishedAt).not.toBeNull();
  });

  it('normalises an unknown throw into an unexpected failure', () => {
    const failed = failJob(createAnalysisJob(VIDEO_ID), 'something odd');
    expect(failed.failure?.kind).toBe('unexpected');
  });

  it('refuses to overwrite a terminal outcome', () => {
    const cancelled = cancelJob(createAnalysisJob(VIDEO_ID), 'user changed their mind');
    expect(failJob(cancelled, mediaError('late', 'Too late.'))).toBe(cancelled);
    expect(cancelled.state).toBe('CANCELLED');
    expect(cancelled.history.at(-1)!.note).toBe('user changed their mind');
  });
});

describe('job factories and store', () => {
  let store: SqliteJobStore;

  // A fresh in-memory database per test; jobs reference a video by foreign key.
  beforeEach(async () => {
    const db = openDatabase(':memory:');
    await new SqliteVideoRepository(db).create(makeVideoAsset());
    store = new SqliteJobStore(db);
  });

  it('creates analysis jobs in QUEUED with an empty result', () => {
    const job = createAnalysisJob(VIDEO_ID);
    expect(job.type).toBe('analysis');
    expect(job.state).toBe('QUEUED');
    expect(job.progress).toBe(0);
    expect(job.result).toEqual({
      transcriptId: null,
      candidateClipIds: [],
      selectedClipPlanIds: [],
      renderIds: [],
    });
  });

  it('creates render jobs bound to a clip plan', () => {
    const job = createRenderJob(VIDEO_ID, 'plan-1' as ClipPlanId);
    expect(job.type).toBe('render');
    expect(job.clipPlanId).toBe('plan-1');
    expect(job.result).toBeNull();
  });

  it('round-trips a job and persists transitions', async () => {
    const created = await store.create(createAnalysisJob(VIDEO_ID));
    await store.save(transitionJob(created, 'UPLOADING'));

    const loaded = await store.get(created.id);
    expect(loaded.state).toBe('UPLOADING');
  });

  it('returns null for a missing job but throws from get', async () => {
    const missing = 'deadbeef-0000-4000-8000-000000000000' as JobId;
    expect(await store.find(missing)).toBeNull();
    await expect(store.get(missing)).rejects.toMatchObject({ kind: 'not_found', code: 'job_not_found' });
  });

  it('filters listings by type, video and state', async () => {
    await store.create(createAnalysisJob(VIDEO_ID));
    await store.create(createRenderJob(VIDEO_ID, 'plan-1' as ClipPlanId));

    expect(await store.list()).toHaveLength(2);
    expect(await store.list({ type: 'render' })).toHaveLength(1);
    expect(await store.list({ state: 'QUEUED' })).toHaveLength(2);
    expect(await store.list({ state: 'COMPLETED' })).toHaveLength(0);
    expect(await store.list({ videoId: 'other' as typeof VIDEO_ID })).toHaveLength(0);
  });

  it('preserves history, failure and result across a round trip', async () => {
    const created = await store.create(createAnalysisJob(VIDEO_ID));
    const failed = failJob(transitionJob(created, 'ANALYZING'), mediaError('no_audio_stream', 'No audio.'));
    await store.save(failed);

    const loaded = await store.get(created.id);
    expect(loaded.state).toBe('FAILED');
    expect(loaded.failure).toMatchObject({ kind: 'media', code: 'no_audio_stream' });
    expect(loaded.history.map((h) => h.state)).toEqual(['QUEUED', 'ANALYZING', 'FAILED']);
  });

  it('keeps a render job distinguishable from an analysis job', async () => {
    const render = await store.create(createRenderJob(VIDEO_ID, 'plan-9' as ClipPlanId));
    const loaded = await store.get(render.id);

    expect(loaded.type).toBe('render');
    expect(loaded.type === 'render' && loaded.clipPlanId).toBe('plan-9');
  });
});
