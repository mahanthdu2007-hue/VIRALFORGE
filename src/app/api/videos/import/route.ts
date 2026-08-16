/**
 * POST /api/videos/import — register a source video from a YouTube link.
 *
 * The counterpart to `POST /api/videos`, which takes bytes. Everything after the
 * file exists is deliberately identical: probe it, register it, hand back the
 * same `VideoAsset` shape, and leave analysis to its own job. A caller that can
 * upload can import by swapping one request.
 *
 * The download runs inline rather than as a job, because the client has nothing
 * to show until the video exists — but it is bounded by size, duration and a
 * wall clock in `downloadYoutubeVideo`, so the request cannot hang forever.
 */

import type { NextRequest } from 'next/server';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { handleRoute, jsonOk } from '@/lib/api';
import { mediaError, validationError } from '@/lib/errors';
import { downloadYoutubeVideo, parseYoutubeUrl } from '@/media/youtube';
import { sanitiseFilename } from '@/storage/file-store';
import { getRuntime } from '@/runtime';
import { nowIso, uuidFactory, type VideoAsset, type VideoId } from '@/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Downloading a long source outlasts the default serverless-style budget. */
export const maxDuration = 1800;

export async function POST(request: NextRequest) {
  const rt = getRuntime();

  return handleRoute(rt.logger, 'POST /api/videos/import', async () => {
    const body = await request.json().catch(() => {
      throw validationError('invalid_json', 'Request body must be valid JSON.');
    });

    const raw = (body as { url?: unknown }).url;
    if (typeof raw !== 'string') {
      throw validationError('missing_url', 'Provide a "url" field with the YouTube link.');
    }

    // Rejects a URL we will not fetch before anything is created on disk.
    const url = parseYoutubeUrl(raw);

    const toolchain = await rt.media.toolchain();
    if (!toolchain.available) {
      throw mediaError('toolchain_unavailable', 'FFmpeg is not available on this machine.', {
        details: { ffmpeg: toolchain.ffmpeg.error, ffprobe: toolchain.ffprobe.error },
      });
    }

    const id = uuidFactory() as VideoId;
    await rt.files.init();

    const download = await downloadYoutubeVideo({
      url,
      directory: rt.files.absolutePath('uploads'),
      basename: id,
      maxBytes: rt.config.storage.maxUploadBytes,
      logger: rt.logger,
    });

    const storageKey = `uploads/${path.basename(download.filePath)}`;

    let metadata;
    try {
      metadata = await rt.media.probe(download.filePath);
    } catch (error) {
      // Bytes we cannot probe are not a video, and keeping them wastes the disk
      // this download just filled.
      await fsp.rm(download.filePath, { force: true });
      throw error;
    }

    const asset: VideoAsset = {
      id,
      // The video's own title, so the library reads like YouTube rather than
      // like a list of identifiers.
      originalFilename: `${sanitiseFilename(download.title)}.mp4`,
      storageKey,
      sizeBytes: download.sizeBytes,
      mimeType: 'video/mp4',
      createdAt: nowIso(),
      metadata,
    };

    await rt.videos.create(asset);
    rt.logger.info('video imported', {
      videoId: id,
      source: download.webpageUrl,
      durationSec: metadata.durationSec,
      sizeBytes: download.sizeBytes,
    });

    return jsonOk({ video: asset }, 201);
  });
}
