/**
 * GET /api/videos/:id/renders — the rendered Shorts of one analysis run.
 *
 * Scoped to a *job*, not to the video. A video can be analysed more than once,
 * and each run builds its own clip plans and its own renders; listing every row
 * the video ever produced showed five Shorts for a run that made one, with the
 * previous runs' clips presented as the current results. So the run is chosen
 * first — `?jobId=` when the client knows which one it is watching, otherwise
 * the most recent analysis job for the video — and only that run's clips are
 * returned, capped at `MAX_RENDERED_CLIPS`.
 *
 * The run's own `selectedClipPlanIds` is what identifies them: a clip plan
 * belongs to exactly one run, `clip_renders` holds one row per plan, and the
 * list is already ranked. That also means a render appears as soon as its clip
 * finishes, rather than only once the whole stage has recorded `renderIds`.
 *
 * Each render is joined with its plan for rank and title, so a client can build
 * a results card without a second round trip. A render with status `RENDERED`
 * carries a `downloadUrl`; a `FAILED` one carries `error` instead — never both,
 * since a failed render has no file to point at.
 */

import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/lib/api';
import { idParamSchema, parseOrThrow } from '@/validation/schemas';
import { getRuntime } from '@/runtime';
import { MAX_RENDERED_CLIPS } from '@/pipeline/render-stage';
import type { AnalysisJob, ClipPlanId, JobId, VideoId } from '@/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const rt = getRuntime();

  return handleRoute(rt.logger, 'GET /api/videos/:id/renders', async () => {
    const { id } = await context.params;
    const videoId = parseOrThrow(idParamSchema, id, 'invalid_video_id') as VideoId;
    await rt.videos.get(videoId);

    const requestedJobId = new URL(request.url).searchParams.get('jobId');
    const job = await resolveJob(rt, videoId, requestedJobId);

    // No run means no results — never the rows some earlier run left behind.
    if (!job) return jsonOk({ jobId: null, count: 0, limit: MAX_RENDERED_CLIPS, renders: [] });

    const planIds = job.result.selectedClipPlanIds.slice(0, MAX_RENDERED_CLIPS);
    const [renders, plans] = await Promise.all([
      Promise.all(planIds.map((planId) => rt.clipRenders.findByClipPlan(planId))),
      rt.clipPlans.listByVideo(videoId),
    ]);
    const planById = new Map<ClipPlanId, (typeof plans)[number]>(plans.map((plan) => [plan.id, plan]));

    const items = renders
      .filter((render) => render !== null)
      .map((render) => {
        const plan = planById.get(render.clipPlanId) ?? null;
        return {
          id: render.id,
          clipPlanId: render.clipPlanId,
          status: render.status,
          durationSec: render.durationSec,
          width: render.width,
          height: render.height,
          sizeBytes: render.sizeBytes,
          cueCount: render.cueCount,
          trackerId: render.trackerId,
          error: render.error,
          rank: plan?.rank ?? null,
          title: plan?.title ?? null,
          startSec: plan ? plan.cuts[0]?.startSec ?? null : null,
          endSec: plan ? plan.cuts[plan.cuts.length - 1]?.endSec ?? null : null,
          downloadUrl: render.status === 'RENDERED' ? `/api/renders/${render.id}/download` : null,
          createdAt: render.createdAt,
        };
      })
      // Plan rank first (1, 2, 3…); renders that outlived their plan sort last.
      .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));

    return jsonOk({ jobId: job.id, count: items.length, limit: MAX_RENDERED_CLIPS, renders: items });
  });
}

/**
 * The run whose results are being asked for.
 *
 * An explicit `jobId` is honoured only when it belongs to this video, so a
 * mistyped or stale id reads as "no results" rather than another video's.
 */
async function resolveJob(
  rt: ReturnType<typeof getRuntime>,
  videoId: VideoId,
  requestedJobId: string | null,
): Promise<AnalysisJob | null> {
  if (requestedJobId !== null) {
    const jobId = parseOrThrow(idParamSchema, requestedJobId, 'invalid_job_id') as JobId;
    const job = await rt.jobs.find(jobId);
    return job && job.type === 'analysis' && job.videoId === videoId ? job : null;
  }

  const jobs = await rt.jobs.list({ type: 'analysis', videoId });
  // `list` is newest first, so the head is the run in progress or last finished.
  return (jobs[0] as AnalysisJob | undefined) ?? null;
}
