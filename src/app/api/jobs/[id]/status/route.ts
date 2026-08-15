/**
 * GET /api/jobs/:id/status — small payload for UI polling.
 *
 * Separate from the full job route so the client can poll cheaply without
 * pulling the entire state history on every tick.
 */

import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/lib/api';
import { idParamSchema, parseOrThrow } from '@/validation/schemas';
import { getRuntime } from '@/runtime';
import { isTerminalJobState, JOB_STATE_LABELS, type Job, type JobId, type JobState } from '@/domain';

export const runtime = 'nodejs';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const rt = getRuntime();

  return handleRoute(rt.logger, 'GET /api/jobs/:id/status', async () => {
    const { id } = await context.params;
    const jobId = parseOrThrow(idParamSchema, id, 'invalid_job_id') as JobId;
    const job = await rt.jobs.get(jobId);

    return jsonOk({
      id: job.id,
      type: job.type,
      state: job.state,
      label: JOB_STATE_LABELS[job.state],
      progress: job.progress,
      terminal: isTerminalJobState(job.state),
      updatedAt: job.updatedAt,
      failure: job.failure,
      // Every state this job has actually been in, oldest first, read from its
      // own history. Polling cannot see a stage it did not happen to catch —
      // and a client that starts late, reloads, or misses a tick during a long
      // FFmpeg run sees none of them — so which stages are done is answered
      // from the record rather than from what the browser observed.
      reached: reachedStates(job),
    });
  });
}

/** The distinct states in a job's history, in the order it entered them. */
export function reachedStates(job: Pick<Job, 'history' | 'state'>): JobState[] {
  const seen: JobState[] = [];
  // The current state is included even if a history entry for it was somehow
  // never written: a job in TRANSCRIBING has reached TRANSCRIBING.
  for (const state of [...job.history.map((event) => event.state), job.state]) {
    if (!seen.includes(state)) seen.push(state);
  }
  return seen;
}
