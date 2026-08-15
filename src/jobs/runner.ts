/**
 * In-process job runner.
 *
 * Analysis takes minutes, so it must not run inside the HTTP request that asks
 * for it. This is the lightest thing that satisfies that: a FIFO queue with a
 * concurrency cap, running in the same Node process.
 *
 * No Redis, no broker, no worker pool — an extra service would be more moving
 * parts than the workload justifies, and FFmpeg plus one provider call is not a
 * workload that benefits from distribution. The cap matters: an unbounded runner
 * would put several FFmpeg processes on a 16 GB machine at once.
 *
 * The trade-off is explicit: work queued in memory does not survive a restart.
 * The *job records* do, so an interrupted job is visible as stuck rather than
 * lost, and `recoverInterrupted` marks those on the next boot.
 */

import { isTerminalJobState, type AnalysisJob, type JobId } from '@/domain';
import { toAppError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import type { JobStore } from './store';
import { failJob } from './transitions';

export interface JobRunnerOptions {
  readonly concurrency: number;
  readonly logger: Logger;
  readonly jobs: JobStore;
  /** Does the actual work. Injected so the runner knows nothing about analysis. */
  readonly run: (job: AnalysisJob) => Promise<unknown>;
}

export class JobRunner {
  private readonly queue: AnalysisJob[] = [];
  private readonly active = new Set<JobId>();
  /** Resolves when the queue drains. Test-only affordance. */
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly options: JobRunnerOptions) {}

  /** Queue a job. Returns immediately; the work happens after this tick. */
  enqueue(job: AnalysisJob): void {
    this.queue.push(job);
    this.options.logger.debug('job queued', { jobId: job.id, queueDepth: this.queue.length });
    this.pump();
  }

  get stats(): { queued: number; active: number } {
    return { queued: this.queue.length, active: this.active.size };
  }

  /** Resolves once nothing is queued or running. */
  async whenIdle(): Promise<void> {
    if (this.queue.length === 0 && this.active.size === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (this.active.size < this.options.concurrency) {
      const job = this.queue.shift();
      if (!job) break;
      void this.execute(job);
    }
  }

  private async execute(job: AnalysisJob): Promise<void> {
    this.active.add(job.id);

    try {
      await this.options.run(job);
    } catch (error) {
      // `run` owns failure reporting; reaching here means it threw anyway, and
      // a job left mid-flight would poll forever.
      this.options.logger.error('job runner caught an unhandled failure', error, { jobId: job.id });
      await this.markFailed(job.id, error);
    } finally {
      this.active.delete(job.id);
      this.pump();
      if (this.queue.length === 0 && this.active.size === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  private async markFailed(jobId: JobId, error: unknown): Promise<void> {
    try {
      const latest = await this.options.jobs.find(jobId);
      if (latest && !isTerminalJobState(latest.state)) {
        await this.options.jobs.save(failJob(latest, toAppError(error)));
      }
    } catch (saveError) {
      this.options.logger.error('could not record job failure', saveError, { jobId });
    }
  }
}

/**
 * Fail jobs left running by a previous process.
 *
 * Called once at startup. Without it, a job interrupted by a restart would sit
 * in ANALYZING forever and the UI would poll it indefinitely.
 */
export async function recoverInterrupted(jobs: JobStore, logger: Logger): Promise<number> {
  const all = await jobs.list();
  const stranded = all.filter((job) => !isTerminalJobState(job.state) && job.state !== 'QUEUED');

  for (const job of stranded) {
    await jobs.save(
      failJob(job, toAppError(new Error('Interrupted by a server restart before it could finish.'))),
    );
  }

  if (stranded.length > 0) {
    logger.warn('marked interrupted jobs as failed', { count: stranded.length });
  }
  return stranded.length;
}

/**
 * Re-queue analysis jobs that never started.
 *
 * A QUEUED job has done no work, so restarting it is safe and strictly better
 * than failing it: the queue lives in memory, but the record survived, and this
 * is what closes that gap.
 */
export async function resumeQueued(jobs: JobStore, runner: JobRunner, logger: Logger): Promise<number> {
  const queued = await jobs.list({ type: 'analysis', state: 'QUEUED' });

  for (const job of queued) {
    runner.enqueue(job as AnalysisJob);
  }

  if (queued.length > 0) {
    logger.info('resumed queued jobs', { count: queued.length });
  }
  return queued.length;
}
