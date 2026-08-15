/**
 * Job status reporting: `GET /api/jobs/:id/status`, `GET /api/jobs/:id`, and
 * the stage mapping the Studio draws from them.
 *
 * Regression suite for a real 41-minute run that transcribed, found clips,
 * built them and rendered them, yet showed Transcribing, Finding viral moments
 * and Building Shorts as stages that never happened — while the slow stages
 * either side of them were ticked. Nothing was wrong with the job: those three
 * stages simply began and ended between two 1.5s polls, and the UI was marking
 * stages done from what the browser had observed rather than from the job's own
 * history. So the history is what these tests assert on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Database } from '@/storage/db';
import { SqliteVideoRepository } from '@/storage/video-repository';
import { SqliteTranscriptRepository } from '@/storage/transcript-repository';
import { SqliteCandidateRepository } from '@/storage/candidate-repository';
import { SqliteClipRenderRepository } from '@/storage/clip-render-repository';
import { SqliteJobStore, createAnalysisJob } from '@/jobs/store';
import { transitionJob } from '@/jobs/transitions';
import { createLogger } from '@/lib/logger';
import { stageStatusesForJob } from '@/components/pipeline';
import type { AnalysisJob, CandidateClipId, ClipPlanId, ClipRenderId, TranscriptId } from '@/domain';
import { makeVideoAsset } from './helpers/fixtures';

let db: Database;
let videos: SqliteVideoRepository;
let transcripts: SqliteTranscriptRepository;
let candidates: SqliteCandidateRepository;
let clipRenders: SqliteClipRenderRepository;
let jobs: SqliteJobStore;

const logger = createLogger({ level: 'error', sink: () => {} });

vi.mock('@/runtime', () => ({
  getRuntime: () => ({ logger, videos, transcripts, candidates, clipRenders, jobs }),
}));

const video = makeVideoAsset();

/** A run that walked the whole happy path, exactly as `runAnalysis` drives it. */
const completedRun = (): AnalysisJob => {
  let job = createAnalysisJob(video.id);
  for (const state of ['ANALYZING', 'TRANSCRIBING', 'FINDING_CLIPS', 'BUILDING_CLIPS', 'RENDERING', 'COMPLETED'] as const) {
    job = transitionJob(job, state);
  }
  return job;
};

beforeEach(async () => {
  db = openDatabase(':memory:');
  videos = new SqliteVideoRepository(db);
  transcripts = new SqliteTranscriptRepository(db);
  candidates = new SqliteCandidateRepository(db);
  clipRenders = new SqliteClipRenderRepository(db);
  jobs = new SqliteJobStore(db);
  await videos.create(video);
});

describe('GET /api/jobs/:id/status', () => {
  it('reports every stage the job actually reached, not the ones a client saw', async () => {
    const { GET } = await import('../src/app/api/jobs/[id]/status/route');
    const job = await jobs.create(completedRun());

    const response = await GET(new Request(`http://test/api/jobs/${job.id}/status`) as never, {
      params: Promise.resolve({ id: job.id }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.state).toBe('COMPLETED');
    expect(body.reached).toEqual([
      'QUEUED',
      'ANALYZING',
      'TRANSCRIBING',
      'FINDING_CLIPS',
      'BUILDING_CLIPS',
      'RENDERING',
      'COMPLETED',
    ]);
  });

  it('includes the current state of a run still in flight', async () => {
    const { GET } = await import('../src/app/api/jobs/[id]/status/route');
    const job = await jobs.create(
      transitionJob(transitionJob(createAnalysisJob(video.id), 'ANALYZING'), 'TRANSCRIBING'),
    );

    const response = await GET(new Request(`http://test/api/jobs/${job.id}/status`) as never, {
      params: Promise.resolve({ id: job.id }),
    });
    const body = await response.json();

    expect(body.terminal).toBe(false);
    expect(body.reached).toEqual(['QUEUED', 'ANALYZING', 'TRANSCRIBING']);
  });
});

describe('stage mapping', () => {
  it('ticks every stage a completed run passed through', async () => {
    const job = completedRun();
    const reached = job.history.map((event) => event.state);

    expect(stageStatusesForJob(job.state, reached)).toEqual({
      UPLOADING: 'done',
      ANALYZING: 'done',
      TRANSCRIBING: 'done',
      FINDING_CLIPS: 'done',
      BUILDING_CLIPS: 'done',
      RENDERING: 'done',
    });
  });

  it('leaves a stage the run never entered pending', () => {
    // A run that found nothing to build stops before rendering; that stage is
    // pending, not done, because nobody did the work.
    let job = createAnalysisJob(video.id);
    for (const state of ['ANALYZING', 'TRANSCRIBING', 'FINDING_CLIPS', 'BUILDING_CLIPS', 'COMPLETED'] as const) {
      job = transitionJob(job, state);
    }

    const statuses = stageStatusesForJob(job.state, job.history.map((event) => event.state));
    expect(statuses.BUILDING_CLIPS).toBe('done');
    expect(statuses.RENDERING).toBe('pending');
  });

  it('marks the stage that was running when a run failed', () => {
    let job = createAnalysisJob(video.id);
    for (const state of ['ANALYZING', 'TRANSCRIBING', 'FAILED'] as const) {
      job = transitionJob(job, state);
    }

    const statuses = stageStatusesForJob(job.state, job.history.map((event) => event.state));
    expect(statuses.ANALYZING).toBe('done');
    expect(statuses.TRANSCRIBING).toBe('failed');
    expect(statuses.FINDING_CLIPS).toBe('pending');
  });
});

describe('GET /api/jobs/:id', () => {
  /**
   * Regression: the UI reported "60 candidate moments" for a run that found
   * twelve. Five runs of the same video had each stored twelve, and the counts
   * were taken over the *video* rather than the run being asked about.
   */
  it('counts what this run produced, not what the video has accumulated', async () => {
    const { GET } = await import('../src/app/api/jobs/[id]/route');

    const runOf = async (label: string): Promise<AnalysisJob> =>
      jobs.create({
        ...completedRun(),
        result: {
          transcriptId: null as TranscriptId | null,
          candidateClipIds: [`${label}-c1`, `${label}-c2`] as CandidateClipId[],
          selectedClipPlanIds: [`${label}-p1`] as ClipPlanId[],
          renderIds: [`${label}-r1`] as ClipRenderId[],
        },
      });

    await runOf('first');
    const second = await runOf('second');

    const response = await GET(new Request(`http://test/api/jobs/${second.id}`) as never, {
      params: Promise.resolve({ id: second.id }),
    });
    const body = await response.json();

    expect(body.candidates.count).toBe(2);
    expect(body.renders.count).toBe(1);
    // And the link it hands out cannot resolve to the other run's clips.
    expect(body.renders.url).toBe(`/api/videos/${video.id}/renders?jobId=${second.id}`);
  });
});
