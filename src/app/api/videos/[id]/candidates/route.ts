/**
 * GET /api/videos/:id/candidates — discovered moments for a video.
 *
 * Every candidate here has already passed the verbatim guard: its `hookQuote`
 * was verified against the transcript before it was stored.
 */

import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/lib/api';
import { idParamSchema, parseOrThrow } from '@/validation/schemas';
import { getRuntime } from '@/runtime';
import { candidateDuration, type VideoId } from '@/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const rt = getRuntime();

  return handleRoute(rt.logger, 'GET /api/videos/:id/candidates', async () => {
    const { id } = await context.params;
    const videoId = parseOrThrow(idParamSchema, id, 'invalid_video_id') as VideoId;
    await rt.videos.get(videoId);

    const candidates = await rt.candidates.listByVideo(videoId);

    return jsonOk({
      count: candidates.length,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        transcriptId: candidate.transcriptId,
        startSec: candidate.startSec,
        endSec: candidate.endSec,
        durationSec: Math.round(candidateDuration(candidate) * 1000) / 1000,
        text: candidate.text,
        hookQuote: candidate.hookQuote,
        topic: candidate.topic,
        reason: candidate.reason,
        signals: candidate.signals,
        confidence: candidate.confidence,
        // Null until the dedicated scoring phase runs.
        score: candidate.score,
        segmentIds: candidate.segmentIds,
        createdAt: candidate.createdAt,
      })),
    });
  });
}
