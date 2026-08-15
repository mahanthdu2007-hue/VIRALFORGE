/**
 * POST /api/analysis — start an analysis run for a video.
 *
 * Creates the job, hands it to the runner and returns 202 immediately. The work
 * (audio extraction, transcription, discovery) takes minutes and must not hold
 * an HTTP connection open; the client follows progress via
 * `GET /api/jobs/:id/status`.
 */

import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/lib/api';
import { mediaError, validationError } from '@/lib/errors';
import { createAnalysisSchema, parseOrThrow } from '@/validation/schemas';
import { createAnalysisJob } from '@/jobs/store';
import { getRuntime } from '@/runtime';
import { JOB_STATE_LABELS, type VideoId } from '@/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const rt = getRuntime();

  return handleRoute(rt.logger, 'POST /api/analysis', async () => {
    const body = await request.json().catch(() => {
      throw validationError('invalid_json', 'Request body must be valid JSON.');
    });

    const input = parseOrThrow(createAnalysisSchema, body);
    const video = await rt.videos.get(input.videoId as VideoId);

    if (video.metadata && !video.metadata.hasAudio) {
      throw mediaError('no_audio_stream', 'This video has no audio track, so it cannot be transcribed.', {
        details: { videoId: video.id },
      });
    }

    // Fail before queueing rather than inside the job: a provider that is not
    // configured is the caller's problem to fix, and it is not worth a job
    // record that can only ever fail.
    rt.aiProvider();

    const toolchain = await rt.media.toolchain();
    if (!toolchain.available) {
      throw mediaError('toolchain_unavailable', 'FFmpeg is not available on this machine.');
    }

    const job = await rt.jobs.create(createAnalysisJob(video.id));
    rt.runner.enqueue(job);

    rt.logger.info('analysis queued', { jobId: job.id, videoId: video.id, ...rt.runner.stats });

    return jsonOk(
      {
        job: {
          id: job.id,
          state: job.state,
          label: JOB_STATE_LABELS[job.state],
          progress: job.progress,
          videoId: job.videoId,
          createdAt: job.createdAt,
        },
        statusUrl: `/api/jobs/${job.id}/status`,
      },
      202,
    );
  });
}
