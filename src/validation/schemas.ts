/**
 * Input validation at the API boundary.
 *
 * Nothing past this layer re-checks shapes; everything inside works with typed
 * domain objects. Failures raise `validation` errors, which map to HTTP 400.
 */

import { z } from 'zod';
import { validationError } from '@/lib/errors';
import {
  ACCEPTED_VIDEO_EXTENSIONS,
  ACCEPTED_VIDEO_MIME_TYPES,
  isAcceptedVideoExtension,
  isAcceptedVideoMimeType,
} from './media-types';

export * from './media-types';

export interface UploadCandidate {
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
}

/**
 * Gate an upload before a single byte is written to disk.
 * @throws AppError kind=validation
 */
export function assertUploadAcceptable(candidate: UploadCandidate, maxBytes: number): void {
  const { filename, mimeType, sizeBytes } = candidate;

  if (!filename.trim()) {
    throw validationError('missing_filename', 'The upload has no filename.');
  }

  if (!isAcceptedVideoExtension(filename)) {
    throw validationError('unsupported_extension', 'That file type is not supported.', {
      details: { filename, accepted: ACCEPTED_VIDEO_EXTENSIONS },
    });
  }

  if (!isAcceptedVideoMimeType(mimeType)) {
    throw validationError('unsupported_mime_type', 'That media type is not supported.', {
      details: { mimeType, accepted: ACCEPTED_VIDEO_MIME_TYPES },
    });
  }

  if (sizeBytes !== undefined) {
    if (sizeBytes <= 0) {
      throw validationError('empty_upload', 'The uploaded file is empty.');
    }
    if (sizeBytes > maxBytes) {
      throw validationError('upload_too_large', 'Upload exceeds the configured size limit.', {
        details: { sizeBytes, maxBytes },
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Request bodies and params                                                  */
/* -------------------------------------------------------------------------- */

export const idParamSchema = z.string().uuid('Expected a UUID.');

export const createAnalysisSchema = z.object({
  videoId: idParamSchema,
  /** How many Shorts to produce. The product targets 3. */
  clipCount: z.number().int().min(1).max(5).default(3),
});

export type CreateAnalysisInput = z.infer<typeof createAnalysisSchema>;

/**
 * Parse with a schema, converting Zod issues into an `AppError`.
 * @throws AppError kind=validation
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, code = 'invalid_request'): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw validationError(code, 'Request payload is invalid.', {
    details: {
      issues: result.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', problem: i.message })),
    },
  });
}
