/**
 * Pure state-machine operations on jobs.
 *
 * Every function returns a new job object; nothing mutates. The store persists
 * whatever these return, which keeps the machine trivially testable.
 */

import {
  canTransition,
  isTerminalJobState,
  JOB_STATE_PROGRESS,
  nowIso,
  type Job,
  type JobEvent,
  type JobFailure,
  type JobState,
} from '@/domain';
import { processingError, toAppError } from '@/lib/errors';

interface TransitionOptions {
  /** Free-text note recorded in the job history. */
  note?: string;
  /** Explicit progress override; defaults to the target state's floor. */
  progress?: number;
}

/**
 * Move a job to `to`.
 *
 * @throws AppError kind=processing when the transition is not declared legal.
 */
export function transitionJob<J extends Job>(job: J, to: JobState, options: TransitionOptions = {}): J {
  if (!canTransition(job.state, to)) {
    throw processingError('illegal_job_transition', `Cannot move job from ${job.state} to ${to}.`, {
      details: { jobId: job.id, from: job.state, to },
    });
  }

  const at = nowIso();
  const event: JobEvent = { state: to, at, note: options.note ?? null };
  const floor = JOB_STATE_PROGRESS[to];
  const progress = clampProgress(options.progress ?? Math.max(job.progress, floor));

  return {
    ...job,
    state: to,
    progress,
    updatedAt: at,
    startedAt: job.startedAt ?? (to === 'QUEUED' ? null : at),
    finishedAt: isTerminalJobState(to) ? at : null,
    history: [...job.history, event],
  };
}

/** Record fine-grained progress inside the current state. Never moves backwards. */
export function setJobProgress<J extends Job>(job: J, progress: number): J {
  const next = clampProgress(progress);
  if (next <= job.progress) return job;
  return { ...job, progress: next, updatedAt: nowIso() };
}

/**
 * Move a job to FAILED, capturing the error in serialisable form.
 * Already-terminal jobs are returned untouched — a late failure must not
 * overwrite a completed or cancelled outcome.
 */
export function failJob<J extends Job>(job: J, error: unknown): J {
  if (isTerminalJobState(job.state)) return job;

  const app = toAppError(error);
  const at = nowIso();
  const failure: JobFailure = { kind: app.kind, code: app.code, message: app.message, at };

  return {
    ...transitionJob(job, 'FAILED', { note: app.code, progress: job.progress }),
    failure,
  };
}

export function cancelJob<J extends Job>(job: J, reason?: string): J {
  if (isTerminalJobState(job.state)) return job;
  return transitionJob(job, 'CANCELLED', { note: reason ?? 'cancelled by user', progress: job.progress });
}

const clampProgress = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
};
