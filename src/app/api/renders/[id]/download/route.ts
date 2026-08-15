/**
 * GET /api/renders/:id/download — stream a rendered Short.
 *
 * The only input from the caller is the render id; the file path is resolved
 * exclusively through the stored `ClipRender` record's `storageKey`; nothing
 * here accepts or interpolates a filesystem path from the request. Serves
 * inline (not `Content-Disposition: attachment`) so the same URL works both
 * as a `<video>` preview source and, via an anchor's `download` attribute, as
 * an explicit download.
 *
 * Supports byte-range requests so the browser can seek/scrub a preview
 * without pulling the whole file.
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { NextResponse, type NextRequest } from 'next/server';
import { handleRoute } from '@/lib/api';
import { notFoundError } from '@/lib/errors';
import { idParamSchema, parseOrThrow } from '@/validation/schemas';
import { getRuntime } from '@/runtime';
import type { ClipRenderId } from '@/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONTENT_TYPE = 'video/mp4';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const rt = getRuntime();

  return handleRoute(rt.logger, 'GET /api/renders/:id/download', async () => {
    const { id } = await context.params;
    const renderId = parseOrThrow(idParamSchema, id, 'invalid_render_id') as ClipRenderId;

    const render = await rt.clipRenders.find(renderId);
    if (!render) {
      throw notFoundError('render_not_found', 'No render exists with that id.', { details: { renderId } });
    }
    if (render.status !== 'RENDERED' || !render.storageKey) {
      throw notFoundError('render_not_available', 'This render has no file to download.', {
        details: { renderId, status: render.status },
      });
    }

    // `absolutePath` resolves through the storage root and rejects anything
    // that would escape it — the key came from the DB, never the request, but
    // the guard stays defense-in-depth.
    const absPath = rt.files.absolutePath(render.storageKey);
    const stat = await fsp.stat(absPath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw notFoundError('render_file_missing', 'The rendered file is no longer available.', {
        details: { renderId },
      });
    }

    return streamFile(absPath, stat.size, request.headers.get('range'), renderId);
  });
}

function streamFile(absPath: string, size: number, rangeHeader: string | null, renderId: string): NextResponse {
  const filename = `${renderId}.mp4`;
  const range = parseRange(rangeHeader, size);

  if (range === 'unsatisfiable') {
    return new NextResponse(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' },
    });
  }

  if (range) {
    const { start, end } = range;
    return new NextResponse(fileStream(absPath, { start, end }), {
      status: 206,
      headers: {
        'content-type': CONTENT_TYPE,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'content-disposition': `inline; filename="${filename}"`,
      },
    });
  }

  return new NextResponse(fileStream(absPath), {
    status: 200,
    headers: {
      'content-type': CONTENT_TYPE,
      'content-length': String(size),
      'accept-ranges': 'bytes',
      'content-disposition': `inline; filename="${filename}"`,
    },
  });
}

/**
 * The file as a web stream, with cancellation owned explicitly.
 *
 * `Readable.toWeb` closes its controller from the file's `end` event even when
 * the consumer has already cancelled, and that throws `ERR_INVALID_STATE` from
 * inside Node with nothing to catch it — an uncaught exception in the server.
 * A `<video>` element triggers it on every seek and on leaving the page, so it
 * is the normal path, not an edge case. One flag settles the race: whichever of
 * end, error or cancel happens first is the one that acts.
 */
function fileStream(absPath: string, options?: { start: number; end: number }): ReadableStream<Uint8Array> {
  const source = fs.createReadStream(absPath, options);
  let settled = false;
  const settle = (finish: () => void): void => {
    if (settled) return;
    settled = true;
    finish();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on('data', (chunk) => {
        if (settled) return;
        controller.enqueue(new Uint8Array(chunk as Buffer));
        // Respect backpressure: resume in `pull` once the consumer wants more.
        if ((controller.desiredSize ?? 1) <= 0) source.pause();
      });
      source.on('end', () => settle(() => controller.close()));
      source.on('error', (error) => settle(() => controller.error(error)));
    },
    pull() {
      source.resume();
    },
    cancel() {
      settle(() => {});
      source.destroy();
    },
  });
}

type Range = { start: number; end: number } | 'unsatisfiable' | null;

function parseRange(rangeHeader: string | null, size: number): Range {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const [, startStr, endStr] = match as unknown as [string, string, string];
  if (startStr === '' && endStr === '') return null;

  let start: number;
  let end: number;
  if (startStr === '') {
    // Suffix range: last N bytes.
    const suffixLength = Number(endStr);
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Number(endStr);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return 'unsatisfiable';
  }

  return { start, end: Math.min(end, size - 1) };
}
