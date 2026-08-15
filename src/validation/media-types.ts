/**
 * Accepted upload formats.
 *
 * Dependency-free on purpose: the browser bundle imports this to populate the
 * file picker, so nothing here may touch `node:*`.
 */

/** Containers we are willing to hand to FFmpeg. */
export const ACCEPTED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi'] as const;

export const ACCEPTED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/x-m4v',
  'video/x-msvideo',
] as const;

/** Lower-cased extension including the dot, or '' when there is none. */
export function fileExtension(filename: string): string {
  const base = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export const isAcceptedVideoExtension = (filename: string): boolean =>
  (ACCEPTED_VIDEO_EXTENSIONS as readonly string[]).includes(fileExtension(filename));

/**
 * A browser may send an empty or generic MIME type, so the extension is
 * authoritative and the MIME type is only rejected when it clearly disagrees.
 */
export const isAcceptedVideoMimeType = (mimeType: string): boolean =>
  mimeType === '' ||
  mimeType === 'application/octet-stream' ||
  (ACCEPTED_VIDEO_MIME_TYPES as readonly string[]).includes(mimeType);
