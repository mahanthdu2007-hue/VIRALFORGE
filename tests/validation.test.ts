import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_VIDEO_EXTENSIONS,
  assertUploadAcceptable,
  createAnalysisSchema,
  isAcceptedVideoExtension,
  isAcceptedVideoMimeType,
  parseOrThrow,
} from '@/validation/schemas';
import { sanitiseFilename } from '@/storage/file-store';
import { isAppError } from '@/lib/errors';
import { VIDEO_ID } from './helpers/fixtures';

const MAX = 100 * 1024 * 1024;

describe('accepted media types', () => {
  it.each(ACCEPTED_VIDEO_EXTENSIONS)('accepts %s', (ext) => {
    expect(isAcceptedVideoExtension(`clip${ext}`)).toBe(true);
    expect(isAcceptedVideoExtension(`CLIP${ext.toUpperCase()}`)).toBe(true);
  });

  it.each(['notes.txt', 'audio.mp3', 'archive.zip', 'noextension'])('rejects %s', (name) => {
    expect(isAcceptedVideoExtension(name)).toBe(false);
  });

  it('tolerates a blank or generic MIME type from the browser', () => {
    expect(isAcceptedVideoMimeType('')).toBe(true);
    expect(isAcceptedVideoMimeType('application/octet-stream')).toBe(true);
    expect(isAcceptedVideoMimeType('video/mp4')).toBe(true);
    expect(isAcceptedVideoMimeType('image/png')).toBe(false);
  });
});

describe('assertUploadAcceptable', () => {
  it('accepts a plausible upload', () => {
    expect(() =>
      assertUploadAcceptable({ filename: 'keynote.mp4', mimeType: 'video/mp4', sizeBytes: 1024 }, MAX),
    ).not.toThrow();
  });

  it.each([
    [{ filename: '   ', mimeType: 'video/mp4' }, 'missing_filename'],
    [{ filename: 'notes.txt', mimeType: 'text/plain' }, 'unsupported_extension'],
    [{ filename: 'clip.mp4', mimeType: 'image/png' }, 'unsupported_mime_type'],
    [{ filename: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 0 }, 'empty_upload'],
    [{ filename: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: MAX + 1 }, 'upload_too_large'],
  ])('rejects %j as %s', (candidate, code) => {
    try {
      assertUploadAcceptable(candidate, MAX);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return;
      expect(error.kind).toBe('validation');
      expect(error.code).toBe(code);
    }
  });
});

describe('sanitiseFilename', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\clip.mp4', 'clip.mp4'],
    ['my keynote (final).mp4', 'my keynote _final_.mp4'],
    ['..', 'file'],
    ['', 'file'],
  ])('reduces %s to %s', (input, expected) => {
    expect(sanitiseFilename(input)).toBe(expected);
  });

  it('caps absurdly long names', () => {
    expect(sanitiseFilename(`${'a'.repeat(500)}.mp4`).length).toBeLessThanOrEqual(180);
  });
});

describe('createAnalysisSchema', () => {
  it('defaults to three clips', () => {
    expect(parseOrThrow(createAnalysisSchema, { videoId: VIDEO_ID })).toEqual({
      videoId: VIDEO_ID,
      clipCount: 3,
    });
  });

  it.each([
    [{}, 'videoId'],
    [{ videoId: 'not-a-uuid' }, 'videoId'],
    [{ videoId: VIDEO_ID, clipCount: 0 }, 'clipCount'],
    [{ videoId: VIDEO_ID, clipCount: 99 }, 'clipCount'],
    [{ videoId: VIDEO_ID, clipCount: 2.5 }, 'clipCount'],
  ])('rejects %j on field %s', (body, field) => {
    try {
      parseOrThrow(createAnalysisSchema, body);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return;
      expect(error.kind).toBe('validation');
      expect(JSON.stringify(error.details)).toContain(field);
    }
  });
});
