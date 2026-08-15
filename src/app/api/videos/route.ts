/**
 * POST /api/videos — register a source video.
 *
 * The body is the raw file, streamed straight to disk; the filename arrives in
 * the `x-filename` header. `multipart/form-data` is deliberately avoided: Next's
 * `formData()` would buffer the whole video in RAM.
 *
 * The response includes real ffprobe metadata. No pipeline work happens here —
 * analysis is a separate job.
 */

import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/lib/api';
import { mediaError, validationError } from '@/lib/errors';
import { assertUploadAcceptable } from '@/validation/schemas';
import { sanitiseFilename } from '@/storage/file-store';
import { getRuntime } from '@/runtime';
import { nowIso, uuidFactory, type VideoAsset, type VideoId } from '@/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const rt = getRuntime();

  return handleRoute(rt.logger, 'POST /api/videos', async () => {
    const filename = decodeFilenameHeader(request.headers.get('x-filename'));
    const mimeType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim();
    const declaredSize = Number(request.headers.get('content-length') ?? NaN);

    assertUploadAcceptable(
      {
        filename,
        mimeType,
        ...(Number.isFinite(declaredSize) && declaredSize > 0 ? { sizeBytes: declaredSize } : {}),
      },
      rt.config.storage.maxUploadBytes,
    );

    if (!request.body) {
      throw validationError('missing_body', 'The request has no body to store.');
    }

    // FFmpeg must exist before we accept bytes we could never process.
    const toolchain = await rt.media.toolchain();
    if (!toolchain.available) {
      throw mediaError('toolchain_unavailable', 'FFmpeg is not available on this machine.', {
        details: { ffmpeg: toolchain.ffmpeg.error, ffprobe: toolchain.ffprobe.error },
      });
    }

    const id = uuidFactory() as VideoId;
    await rt.files.init();

    const stored = await rt.files.writeStream('uploads', `${id}__${sanitiseFilename(filename)}`, request.body, {
      maxBytes: rt.config.storage.maxUploadBytes,
    });

    rt.logger.info('upload stored', { videoId: id, key: stored.key, sizeBytes: stored.sizeBytes });

    let metadata;
    try {
      metadata = await rt.media.probe(rt.files.absolutePath(stored.key));
    } catch (error) {
      // Unprobeable bytes are not a video; do not keep them around.
      await rt.files.remove(stored.key);
      throw error;
    }

    const asset: VideoAsset = {
      id,
      originalFilename: filename,
      storageKey: stored.key,
      sizeBytes: stored.sizeBytes,
      mimeType: mimeType || 'application/octet-stream',
      createdAt: nowIso(),
      metadata,
    };

    await rt.videos.create(asset);
    rt.logger.info('video registered', { videoId: id, durationSec: metadata.durationSec });

    return jsonOk({ video: asset }, 201);
  });
}

/** Filenames travel percent-encoded because HTTP headers are latin-1 only. */
function decodeFilenameHeader(raw: string | null): string {
  const value = raw?.trim() ?? '';
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    throw validationError('invalid_filename_header', 'The x-filename header is not valid percent-encoding.');
  }
}
