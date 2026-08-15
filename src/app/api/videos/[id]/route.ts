/** GET /api/videos/:id — the stored record plus its probed metadata. */

import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/lib/api';
import { idParamSchema, parseOrThrow } from '@/validation/schemas';
import { getRuntime } from '@/runtime';
import type { VideoId } from '@/domain';

export const runtime = 'nodejs';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const rt = getRuntime();

  return handleRoute(rt.logger, 'GET /api/videos/:id', async () => {
    const { id } = await context.params;
    const videoId = parseOrThrow(idParamSchema, id, 'invalid_video_id') as VideoId;
    const video = await rt.videos.get(videoId);
    return jsonOk({ video });
  });
}
