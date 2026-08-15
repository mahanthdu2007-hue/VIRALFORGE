/**
 * GET /api/jobs/:id — the full job record plus what it produced.
 *
 * Includes transcript availability and candidate count so a client can decide
 * what to fetch next without a second round trip.
 */

import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/lib/api';
import { idParamSchema, parseOrThrow } from '@/validation/schemas';
import { getRuntime } from '@/runtime';
import { hasWordTimings, isTerminalJobState, JOB_STATE_LABELS, type JobId, type TranscriptId } from '@/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const rt = getRuntime();

  return handleRoute(rt.logger, 'GET /api/jobs/:id', async () => {
    const { id } = await context.params;
    const jobId = parseOrThrow(idParamSchema, id, 'invalid_job_id') as JobId;
    const job = await rt.jobs.get(jobId);

    const transcriptId = job.type === 'analysis' ? job.result.transcriptId : null;
    const transcript = transcriptId ? await rt.transcripts.find(transcriptId as TranscriptId) : null;

    // What *this run* produced, not what the video has ever accumulated. A
    // second analysis of the same video used to add its candidates and renders
    // to the first run's totals, so five runs of twelve candidates reported
    // sixty, and one Short each reported five.
    const candidateCount = job.type === 'analysis' ? job.result.candidateClipIds.length : 0;
    const renderCount = job.type === 'analysis' ? job.result.renderIds.length : 0;

    return jsonOk({
      job: {
        id: job.id,
        type: job.type,
        state: job.state,
        label: JOB_STATE_LABELS[job.state],
        progress: job.progress,
        terminal: isTerminalJobState(job.state),
        videoId: job.videoId,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        failure: job.failure,
        history: job.history,
        result: job.result,
      },
      transcript: transcript
        ? {
            available: true,
            id: transcript.id,
            language: transcript.language,
            segmentCount: transcript.segments.length,
            hasWordTimings: hasWordTimings(transcript),
            source: transcript.source,
            url: `/api/videos/${job.videoId}/transcript`,
          }
        : { available: false },
      candidates: {
        count: candidateCount,
        url: candidateCount > 0 ? `/api/videos/${job.videoId}/candidates` : null,
      },
      renders: {
        count: renderCount,
        // Job-scoped, so following it can never return an earlier run's clips.
        url: renderCount > 0 ? `/api/videos/${job.videoId}/renders?jobId=${job.id}` : null,
      },
    });
  });
}
