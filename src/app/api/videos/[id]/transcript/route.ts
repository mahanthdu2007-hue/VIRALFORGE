/**
 * GET /api/videos/:id/transcript — the persisted verbatim transcript.
 *
 * Word timings are included only when the provider supplied them; the field is
 * null rather than synthesised.
 */

import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/lib/api';
import { notFoundError } from '@/lib/errors';
import { idParamSchema, parseOrThrow } from '@/validation/schemas';
import { getRuntime } from '@/runtime';
import { hasWordTimings, type VideoId } from '@/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const rt = getRuntime();

  return handleRoute(rt.logger, 'GET /api/videos/:id/transcript', async () => {
    const { id } = await context.params;
    const videoId = parseOrThrow(idParamSchema, id, 'invalid_video_id') as VideoId;

    // Confirms the video exists, so a missing transcript is distinguishable
    // from a missing video.
    await rt.videos.get(videoId);

    const transcript = await rt.transcripts.findByVideo(videoId);
    if (!transcript) {
      throw notFoundError('transcript_not_found', 'This video has not been transcribed yet.', {
        details: { videoId },
      });
    }

    return jsonOk({
      transcript: {
        id: transcript.id,
        videoId: transcript.videoId,
        language: transcript.language,
        source: transcript.source,
        createdAt: transcript.createdAt,
        hasWordTimings: hasWordTimings(transcript),
        segments: transcript.segments,
      },
    });
  });
}
