/**
 * Job persistence.
 *
 * Backed by SQLite so a restart never loses a job. The variable parts of a job
 * — history, failure, result — are stored as JSON columns: they are read and
 * written whole, never queried into, so a relational split would buy nothing.
 */

import {
  nowIso,
  uuidFactory,
  type AnalysisJob,
  type AnalysisResult,
  type ClipPlanId,
  type IdFactory,
  type IsoTimestamp,
  type Job,
  type JobEvent,
  type JobFailure,
  type JobId,
  type JobState,
  type JobType,
  type RenderJob,
  type RenderResult,
  type VideoId,
} from '@/domain';
import { notFoundError, processingError } from '@/lib/errors';
import { asRow, asRows, fromJson, nullableText, toJson, type Database } from '@/storage/db';

export interface JobStore {
  create<J extends Job>(job: J): Promise<J>;
  /** Null when absent — callers decide whether that is an error. */
  find(id: JobId): Promise<Job | null>;
  /** @throws AppError kind=not_found */
  get(id: JobId): Promise<Job>;
  save<J extends Job>(job: J): Promise<J>;
  list(filter?: { type?: JobType; videoId?: VideoId; state?: JobState }): Promise<readonly Job[]>;
}

const COLUMNS =
  'id, type, state, progress, created_at, updated_at, started_at, finished_at, failure_json, history_json, video_id, clip_plan_id, result_json';

export class SqliteJobStore implements JobStore {
  constructor(private readonly db: Database) {}

  async create<J extends Job>(job: J): Promise<J> {
    return this.save(job);
  }

  async save<J extends Job>(job: J): Promise<J> {
    this.db
      .prepare(
        `INSERT INTO jobs (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state        = excluded.state,
           progress     = excluded.progress,
           updated_at   = excluded.updated_at,
           started_at   = excluded.started_at,
           finished_at  = excluded.finished_at,
           failure_json = excluded.failure_json,
           history_json = excluded.history_json,
           result_json  = excluded.result_json`,
      )
      .run(
        job.id,
        job.type,
        job.state,
        job.progress,
        job.createdAt,
        job.updatedAt,
        job.startedAt,
        job.finishedAt,
        job.failure ? toJson(job.failure) : null,
        toJson(job.history),
        job.videoId,
        job.type === 'render' ? job.clipPlanId : null,
        toJson(job.result),
      );

    return job;
  }

  async find(id: JobId): Promise<Job | null> {
    const row = asRow<JobRow>(this.db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE id = ?`).get(id));
    return row ? toJob(row) : null;
  }

  async get(id: JobId): Promise<Job> {
    const job = await this.find(id);
    if (!job) {
      throw notFoundError('job_not_found', `No job with id ${id}.`, { details: { jobId: id } });
    }
    return job;
  }

  async list(filter: { type?: JobType; videoId?: VideoId; state?: JobState } = {}): Promise<readonly Job[]> {
    const where: string[] = [];
    const params: string[] = [];

    if (filter.type) {
      where.push('type = ?');
      params.push(filter.type);
    }
    if (filter.videoId) {
      where.push('video_id = ?');
      params.push(filter.videoId);
    }
    if (filter.state) {
      where.push('state = ?');
      params.push(filter.state);
    }

    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM jobs${clause} ORDER BY created_at DESC`)
      .all(...params);

    return asRows<JobRow>(rows).map(toJob);
  }
}

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                */
/* -------------------------------------------------------------------------- */

interface JobRow {
  id: string;
  type: string;
  state: string;
  progress: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  failure_json: string | null;
  history_json: string;
  video_id: string;
  clip_plan_id: string | null;
  result_json: string;
}

function toJob(row: JobRow): Job {
  const base = {
    id: row.id as JobId,
    state: row.state as JobState,
    progress: row.progress,
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
    startedAt: (row.started_at ?? null) as IsoTimestamp | null,
    finishedAt: (row.finished_at ?? null) as IsoTimestamp | null,
    failure: nullableText(row.failure_json) ? fromJson<JobFailure | null>(row.failure_json, null) : null,
    history: fromJson<JobEvent[]>(row.history_json, []),
    videoId: row.video_id as VideoId,
  };

  if (row.type === 'analysis') {
    return {
      ...base,
      type: 'analysis',
      // Defaults first, parsed second: a row written before a result field
      // existed reads back with that field at its empty value rather than
      // `undefined`, which is what keeps an old job renderable in the UI.
      result: {
        transcriptId: null,
        candidateClipIds: [],
        selectedClipPlanIds: [],
        renderIds: [],
        ...fromJson<Partial<AnalysisResult>>(row.result_json, {}),
      },
    } satisfies AnalysisJob;
  }

  if (row.type === 'render') {
    if (!row.clip_plan_id) {
      throw processingError('corrupt_job_row', 'A render job was stored without a clip plan id.', {
        details: { jobId: row.id },
      });
    }
    return {
      ...base,
      type: 'render',
      clipPlanId: row.clip_plan_id as ClipPlanId,
      result: fromJson<RenderResult | null>(row.result_json, null),
    } satisfies RenderJob;
  }

  throw processingError('corrupt_job_row', `Unknown job type "${row.type}".`, { details: { jobId: row.id } });
}

/* -------------------------------------------------------------------------- */
/* Factories                                                                  */
/* -------------------------------------------------------------------------- */

export function createAnalysisJob(videoId: VideoId, newId: IdFactory = uuidFactory): AnalysisJob {
  const at = nowIso();
  return {
    id: newId() as JobId,
    type: 'analysis',
    state: 'QUEUED',
    progress: 0,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    finishedAt: null,
    failure: null,
    history: [{ state: 'QUEUED', at, note: null }],
    videoId,
    result: { transcriptId: null, candidateClipIds: [], selectedClipPlanIds: [], renderIds: [] },
  };
}

export function createRenderJob(
  videoId: VideoId,
  clipPlanId: ClipPlanId,
  newId: IdFactory = uuidFactory,
): RenderJob {
  const at = nowIso();
  return {
    id: newId() as JobId,
    type: 'render',
    state: 'QUEUED',
    progress: 0,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    finishedAt: null,
    failure: null,
    history: [{ state: 'QUEUED', at, note: null }],
    videoId,
    clipPlanId,
    result: null,
  };
}
