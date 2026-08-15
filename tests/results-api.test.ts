/**
 * Results layer: `GET /api/videos/:id/renders` and `GET /api/renders/:id/download`.
 *
 * `@/runtime` is mocked to a hand-built `Runtime` backed by an in-memory
 * SQLite database and a real `LocalFileStore` pointed at a temp directory —
 * no FFmpeg, no HTTP server, so this proves the route logic (lookup,
 * envelope shape, error mapping, streaming, range handling) without the
 * weight of the real composition root.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openDatabase, type Database } from '@/storage/db';
import { SqliteVideoRepository } from '@/storage/video-repository';
import { SqliteTranscriptRepository } from '@/storage/transcript-repository';
import { SqliteCandidateRepository } from '@/storage/candidate-repository';
import { SqliteClipPlanRepository } from '@/storage/clip-plan-repository';
import { SqliteClipRenderRepository, buildClipRender } from '@/storage/clip-render-repository';
import { LocalFileStore } from '@/storage/file-store';
import { SqliteJobStore, createAnalysisJob } from '@/jobs/store';
import { createLogger } from '@/lib/logger';
import {
  nowIso,
  EMPTY_CLIP_SIGNALS,
  type AnalysisJob,
  type CandidateClip,
  type CandidateClipId,
  type ClipPlanId,
  type IsoTimestamp,
  type TranscriptId,
  type TranscriptSegmentId,
  type VideoAsset,
  type VideoId,
} from '@/domain';
import { makeVideoAsset, makeClipPlan, makeTranscript } from './helpers/fixtures';

let workDir: string;
let db: Database;
let videos: SqliteVideoRepository;
let clipPlans: SqliteClipPlanRepository;
let clipRenders: SqliteClipRenderRepository;
let jobs: SqliteJobStore;
let transcripts: SqliteTranscriptRepository;
let candidates: SqliteCandidateRepository;
let files: LocalFileStore;
let video: VideoAsset;

const logger = createLogger({ level: 'error', sink: () => {} });

vi.mock('@/runtime', () => ({
  getRuntime: () => ({
    logger,
    videos,
    clipPlans,
    clipRenders,
    jobs,
    files,
  }),
}));

/**
 * A completed analysis run that selected `planIds`.
 *
 * Results are job-scoped, so every render in this suite needs the run that
 * produced it on record — exactly as the real pipeline writes it.
 */
const seedJob = async (videoId: VideoId, planIds: readonly ClipPlanId[]): Promise<AnalysisJob> => {
  const job: AnalysisJob = {
    ...createAnalysisJob(videoId),
    state: 'COMPLETED',
    progress: 100,
    result: {
      transcriptId: null,
      candidateClipIds: [],
      selectedClipPlanIds: [...planIds],
      renderIds: [],
    },
  };
  return jobs.create(job);
};

/**
 * One complete analysis run: its own transcript, candidate, clip plan, render
 * and job record.
 *
 * Modelled on what the pipeline actually writes — every run transcribes afresh,
 * so a video analysed twice holds two independent sets of rows, which is the
 * situation the job scoping exists to disentangle.
 */
const seedRun = async (
  label: string,
  minute: number,
): Promise<{ job: AnalysisJob; render: Awaited<ReturnType<typeof clipRenders.save>> }> => {
  const transcriptId = `bbbbbbbb-1111-4111-8111-${label.padEnd(12, '0')}` as TranscriptId;
  const base = makeTranscript([{ startSec: 0, endSec: 40, text: 'We tried it anyway. It worked.' }]);
  const transcript = {
    ...base,
    id: transcriptId,
    videoId: video.id,
    segments: base.segments.map((segment) => ({
      ...segment,
      id: `${label}-${segment.id}` as TranscriptSegmentId,
    })),
  };
  await transcripts.save(transcript);

  const candidateId = `cand-${label}` as CandidateClipId;
  await candidates.saveMany(
    [
      {
        id: candidateId,
        videoId: video.id,
        transcriptId,
        segmentIds: transcript.segments.map((s) => s.id),
        text: transcript.segments[0]!.text,
        hookQuote: null,
        topic: null,
        reason: 'fixture',
        signals: EMPTY_CLIP_SIGNALS,
        confidence: null,
        score: null,
        startSec: 0,
        endSec: 40,
        createdAt: nowIso(),
      },
    ],
    transcriptId,
  );

  const plan = makeClipPlan([{ order: 0, startSec: 0, endSec: 32 }], {
    id: `plan-${label}` as ClipPlanId,
    videoId: video.id,
    transcriptId,
    candidateClipId: candidateId,
    rank: 1,
  });
  await clipPlans.saveMany([plan], transcriptId);

  const render = await clipRenders.save(
    buildClipRender({
      videoId: video.id,
      clipPlanId: plan.id,
      status: 'RENDERED',
      storageKey: `renders/${label}.mp4`,
      durationSec: 32,
      width: 1080,
      height: 1920,
    }),
  );

  // Explicit timestamps: two runs seeded in the same millisecond would leave
  // "the most recent run" ambiguous, which is precisely what is being asserted.
  const at = `2026-08-14T13:5${minute}:00.000Z` as IsoTimestamp;
  const job = await jobs.create({
    ...createAnalysisJob(video.id),
    state: 'COMPLETED',
    progress: 100,
    createdAt: at,
    updatedAt: at,
    result: {
      transcriptId,
      candidateClipIds: [candidateId],
      selectedClipPlanIds: [plan.id],
      renderIds: [render.id],
    },
  } satisfies AnalysisJob);

  return { job, render };
};

beforeAll(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-results-api-'));
  files = new LocalFileStore(workDir);
  await files.init();
});

afterAll(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

/**
 * Seeds a video with the transcript + candidate row its (fixture-default)
 * clip plan needs to satisfy `clip_plans`' foreign keys — this suite never
 * exercises transcript/candidate persistence itself, just borrows minimal
 * rows to get a plan and a render into the database.
 */
beforeEach(async () => {
  db = openDatabase(':memory:');
  videos = new SqliteVideoRepository(db);
  clipPlans = new SqliteClipPlanRepository(db);
  clipRenders = new SqliteClipRenderRepository(db);
  jobs = new SqliteJobStore(db);

  transcripts = new SqliteTranscriptRepository(db);
  candidates = new SqliteCandidateRepository(db);

  video = makeVideoAsset();
  await videos.create(video);

  const transcript = makeTranscript([{ startSec: 0, endSec: 40, text: 'We tried it anyway. It worked.' }]);
  await transcripts.save(transcript);

  const candidate: CandidateClip = {
    id: 'cand-1' as CandidateClipId,
    videoId: video.id,
    transcriptId: transcript.id,
    segmentIds: transcript.segments.map((s) => s.id),
    text: transcript.segments[0]!.text,
    hookQuote: null,
    topic: null,
    reason: 'fixture',
    signals: EMPTY_CLIP_SIGNALS,
    confidence: null,
    score: null,
    startSec: 0,
    endSec: 40,
    createdAt: nowIso(),
  };
  await candidates.saveMany([candidate], transcript.id);
});

const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

describe('GET /api/videos/:id/renders', () => {
  it('returns render summaries joined with plan rank/title', async () => {
    const { GET } = await import('../src/app/api/videos/[id]/renders/route');

    const plan = makeClipPlan([{ order: 0, startSec: 0, endSec: 32 }], {
      id: 'plan-1' as ClipPlanId,
      videoId: video.id,
      rank: 1,
      title: 'The part nobody expected',
    });
    await clipPlans.saveMany([plan], plan.transcriptId);

    const render = buildClipRender({
      videoId: video.id,
      clipPlanId: plan.id,
      status: 'RENDERED',
      storageKey: 'renders/short-1.mp4',
      durationSec: 32,
      width: 1080,
      height: 1920,
      sizeBytes: 4_200_000,
      cueCount: 12,
      trackerId: 'center',
    });
    await clipRenders.save(render);
    await seedJob(video.id, [plan.id]);

    const request = new Request(`http://test/api/videos/${video.id}/renders`);
    const response = await GET(request as never, { params: Promise.resolve({ id: video.id }) });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.count).toBe(1);
    expect(body.renders).toEqual([
      expect.objectContaining({
        id: render.id,
        clipPlanId: plan.id,
        status: 'RENDERED',
        durationSec: 32,
        width: 1080,
        height: 1920,
        sizeBytes: 4_200_000,
        cueCount: 12,
        trackerId: 'center',
        error: null,
        rank: 1,
        title: 'The part nobody expected',
        downloadUrl: `/api/renders/${render.id}/download`,
      }),
    ]);
  });

  it('reports a failed render with its error and no download url', async () => {
    const { GET } = await import('../src/app/api/videos/[id]/renders/route');

    const plan = makeClipPlan([{ order: 0, startSec: 0, endSec: 32 }], {
      id: 'plan-2' as ClipPlanId,
      videoId: video.id,
      rank: 2,
    });
    await clipPlans.saveMany([plan], plan.transcriptId);

    await clipRenders.save(
      buildClipRender({
        videoId: video.id,
        clipPlanId: plan.id,
        status: 'FAILED',
        error: { kind: 'rendering', code: 'ffmpeg_failed', message: 'encoder crashed' },
      }),
    );
    await seedJob(video.id, [plan.id]);

    const request = new Request(`http://test/api/videos/${video.id}/renders`);
    const response = await GET(request as never, { params: Promise.resolve({ id: video.id }) });
    const body = await response.json();

    expect(body.renders[0]).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        downloadUrl: null,
        error: { kind: 'rendering', code: 'ffmpeg_failed', message: 'encoder crashed' },
      }),
    );
  });

  /**
   * Regression: a real 41-minute run reported "5 of 3".
   *
   * The video had been analysed five times; each run built its own plans and
   * rendered its own clip, and the route listed every render the *video* had
   * ever produced. The four earlier runs' Shorts were therefore presented as
   * the current run's results — and, since each run selected the same opening
   * moment, as five copies of the same forty seconds.
   */
  it('returns only the current run\'s renders when a video has been analysed twice', async () => {
    const { GET } = await import('../src/app/api/videos/[id]/renders/route');

    const older = await seedRun('old', 1);
    const newer = await seedRun('new', 2);

    // Both runs' rows are on record …
    expect(await clipRenders.countByVideo(video.id)).toBe(2);

    // … but only the newer run's clip is a current result.
    const response = await GET(
      new Request(`http://test/api/videos/${video.id}/renders`) as never,
      { params: Promise.resolve({ id: video.id }) },
    );
    const body = await response.json();

    expect(body.jobId).toBe(newer.job.id);
    expect(body.count).toBe(1);
    expect(body.renders.map((r: { id: string }) => r.id)).toEqual([newer.render.id]);
    expect(body.renders.map((r: { id: string }) => r.id)).not.toContain(older.render.id);
  });

  it('honours ?jobId= so a client can ask for the run it is watching', async () => {
    const { GET } = await import('../src/app/api/videos/[id]/renders/route');

    const older = await seedRun('old', 1);
    await seedRun('new', 2);

    const response = await GET(
      new Request(`http://test/api/videos/${video.id}/renders?jobId=${older.job.id}`) as never,
      { params: Promise.resolve({ id: video.id }) },
    );
    const body = await response.json();

    expect(body.jobId).toBe(older.job.id);
    expect(body.renders.map((r: { id: string }) => r.id)).toEqual([older.render.id]);
  });

  it('never returns more than the top-3 limit, whatever is on record', async () => {
    const { GET } = await import('../src/app/api/videos/[id]/renders/route');

    const plans = [1, 2, 3, 4, 5].map((rank) =>
      makeClipPlan([{ order: 0, startSec: rank * 60, endSec: rank * 60 + 30 }], {
        id: `plan-limit-${rank}` as ClipPlanId,
        videoId: video.id,
        rank,
      }),
    );
    await clipPlans.saveMany(plans, plans[0]!.transcriptId);

    for (const plan of plans) {
      await clipRenders.save(
        buildClipRender({ videoId: video.id, clipPlanId: plan.id, status: 'RENDERED', storageKey: `renders/${plan.id}.mp4` }),
      );
    }
    // A run that somehow selected five: the server still exposes three.
    await seedJob(video.id, plans.map((plan) => plan.id));

    const response = await GET(
      new Request(`http://test/api/videos/${video.id}/renders`) as never,
      { params: Promise.resolve({ id: video.id }) },
    );
    const body = await response.json();

    expect(body.limit).toBe(3);
    expect(body.count).toBe(3);
    expect(body.renders.map((r: { rank: number }) => r.rank)).toEqual([1, 2, 3]);
  });

  it('reports each render against its own plan\'s source range', async () => {
    const { GET } = await import('../src/app/api/videos/[id]/renders/route');

    const plans = [
      makeClipPlan([{ order: 0, startSec: 12, endSec: 44 }], { id: 'plan-a' as ClipPlanId, videoId: video.id, rank: 1 }),
      makeClipPlan([{ order: 0, startSec: 300, endSec: 335 }], { id: 'plan-b' as ClipPlanId, videoId: video.id, rank: 2 }),
    ];
    await clipPlans.saveMany(plans, plans[0]!.transcriptId);
    for (const plan of plans) {
      await clipRenders.save(
        buildClipRender({ videoId: video.id, clipPlanId: plan.id, status: 'RENDERED', storageKey: `renders/${plan.id}.mp4` }),
      );
    }
    await seedJob(video.id, plans.map((plan) => plan.id));

    const response = await GET(
      new Request(`http://test/api/videos/${video.id}/renders`) as never,
      { params: Promise.resolve({ id: video.id }) },
    );
    const body = await response.json();

    expect(body.renders.map((r: { startSec: number; endSec: number }) => [r.startSec, r.endSec])).toEqual([
      [12, 44],
      [300, 335],
    ]);
  });

  it('returns no results for a video that has never been analysed', async () => {
    const { GET } = await import('../src/app/api/videos/[id]/renders/route');

    const response = await GET(
      new Request(`http://test/api/videos/${video.id}/renders`) as never,
      { params: Promise.resolve({ id: video.id }) },
    );
    const body = await response.json();

    expect(body).toEqual({ jobId: null, count: 0, limit: 3, renders: [] });
  });

  it('404s for an unknown video', async () => {
    const { GET } = await import('../src/app/api/videos/[id]/renders/route');
    const request = new Request(`http://test/api/videos/${UNKNOWN_ID}/renders`);
    const response = await GET(request as never, { params: Promise.resolve({ id: UNKNOWN_ID }) });
    expect(response.status).toBe(404);
  });
});

describe('GET /api/renders/:id/download', () => {
  it('404s when the render id does not exist', async () => {
    const { GET } = await import('../src/app/api/renders/[id]/download/route');
    const request = new Request(`http://test/api/renders/${UNKNOWN_ID}/download`);
    const response = await GET(request as never, { params: Promise.resolve({ id: UNKNOWN_ID }) });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('render_not_found');
  });

  it('rejects a non-UUID id (path traversal attempt) with 400, never touching the filesystem', async () => {
    const { GET } = await import('../src/app/api/renders/[id]/download/route');
    const malicious = encodeURIComponent('../../../../etc/passwd');
    const request = new Request(`http://test/api/renders/${malicious}/download`);
    const response = await GET(request as never, { params: Promise.resolve({ id: malicious }) });
    expect(response.status).toBe(400);
  });

  it('404s for a render that failed and has no file', async () => {
    const { GET } = await import('../src/app/api/renders/[id]/download/route');
    const plan = makeClipPlan([{ order: 0, startSec: 0, endSec: 30 }], {
      id: 'plan-3' as ClipPlanId,
      videoId: video.id,
    });
    await clipPlans.saveMany([plan], plan.transcriptId);

    const render = buildClipRender({
      videoId: video.id,
      clipPlanId: plan.id,
      status: 'FAILED',
      error: { kind: 'rendering', code: 'x', message: 'x' },
    });
    await clipRenders.save(render);

    const request = new Request(`http://test/api/renders/${render.id}/download`);
    const response = await GET(request as never, { params: Promise.resolve({ id: render.id }) });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('render_not_available');
  });

  it('streams a completed render and honours range requests', async () => {
    const { GET } = await import('../src/app/api/renders/[id]/download/route');
    const plan = makeClipPlan([{ order: 0, startSec: 0, endSec: 30 }], {
      id: 'plan-4' as ClipPlanId,
      videoId: video.id,
    });
    await clipPlans.saveMany([plan], plan.transcriptId);

    const payload = Buffer.from('fake mp4 bytes for streaming test 0123456789');
    const stored = await files.writeStream('renders', 'short-download.mp4', Readable.from(payload));

    const render = buildClipRender({
      videoId: video.id,
      clipPlanId: plan.id,
      status: 'RENDERED',
      storageKey: stored.key,
      durationSec: 30,
      width: 1080,
      height: 1920,
      sizeBytes: stored.sizeBytes,
    });
    await clipRenders.save(render);

    // Full-body request.
    const full = await GET(new Request(`http://test/api/renders/${render.id}/download`) as never, {
      params: Promise.resolve({ id: render.id }),
    });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('content-length')).toBe(String(payload.length));
    const fullBody = Buffer.from(await full.arrayBuffer());
    expect(fullBody.equals(payload)).toBe(true);

    // Range request.
    const ranged = await GET(
      new Request(`http://test/api/renders/${render.id}/download`, { headers: { range: 'bytes=5-14' } }) as never,
      { params: Promise.resolve({ id: render.id }) },
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 5-14/${payload.length}`);
    const rangedBody = Buffer.from(await ranged.arrayBuffer());
    expect(rangedBody.equals(payload.subarray(5, 15))).toBe(true);
  });

  it('does not raise an uncaught exception when a consumer cancels mid-stream (regression)', async () => {
    // Regression for a bug where `Readable.toWeb()` closed its controller
    // from the file's `end` event even after the consumer had already
    // cancelled the stream, throwing `ERR_INVALID_STATE: Controller is
    // already closed` as an *uncaught* exception — outside any request's
    // try/catch, so `handleRoute` never saw it. A `<video>` element does
    // exactly this on every seek and on navigating away, so it fired on the
    // ordinary preview path, not an edge case.
    //
    // A large enough payload keeps the file stream mid-flight (still reading
    // more chunks) at the moment the reader cancels, which is what put `end`
    // and `cancel` in a race before the fix.
    const { GET } = await import('../src/app/api/renders/[id]/download/route');
    const plan = makeClipPlan([{ order: 0, startSec: 0, endSec: 30 }], {
      id: 'plan-cancel' as ClipPlanId,
      videoId: video.id,
    });
    await clipPlans.saveMany([plan], plan.transcriptId);

    const payload = Buffer.alloc(5 * 1024 * 1024, 7);
    const stored = await files.writeStream('renders', 'short-cancel-test.mp4', Readable.from(payload));

    const render = buildClipRender({
      videoId: video.id,
      clipPlanId: plan.id,
      status: 'RENDERED',
      storageKey: stored.key,
      sizeBytes: stored.sizeBytes,
    });
    await clipRenders.save(render);

    const uncaught: unknown[] = [];
    const onUncaughtException = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaughtException);

    try {
      for (let i = 0; i < 5; i++) {
        const response = await GET(
          new Request(`http://test/api/renders/${render.id}/download`, {
            headers: { range: `bytes=0-${payload.length - 1}` },
          }) as never,
          { params: Promise.resolve({ id: render.id }) },
        );
        expect(response.status).toBe(206);

        const reader = response.body!.getReader();
        await reader.read(); // one chunk, as a <video> element would buffer
        await reader.cancel(); // then abandon it mid-stream, as a seek/navigation does
        // A second cancel must also be a no-op, not a double-close.
        await expect(reader.cancel()).resolves.toBeUndefined();
      }

      // Give any deferred fs 'end'/'close' event a turn to fire, so a
      // regression would actually surface here instead of after the test.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off('uncaughtException', onUncaughtException);
    }

    expect(uncaught).toEqual([]);
  });

  it('404s when the record exists but the file has been removed from disk', async () => {
    const { GET } = await import('../src/app/api/renders/[id]/download/route');
    const plan = makeClipPlan([{ order: 0, startSec: 0, endSec: 30 }], {
      id: 'plan-5' as ClipPlanId,
      videoId: video.id,
    });
    await clipPlans.saveMany([plan], plan.transcriptId);

    const render = buildClipRender({
      videoId: video.id,
      clipPlanId: plan.id,
      status: 'RENDERED',
      storageKey: 'renders/does-not-exist.mp4',
    });
    await clipRenders.save(render);

    const response = await GET(new Request(`http://test/api/renders/${render.id}/download`) as never, {
      params: Promise.resolve({ id: render.id }),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('render_file_missing');
  });
});
