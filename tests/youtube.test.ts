/**
 * YouTube source import — the URL guard and the failure translation.
 *
 * No network and no subprocess: what is worth testing cheaply here is which
 * URLs reach a subprocess at all, and whether a user is told something they can
 * act on when the download fails. The download itself is exercised by hand
 * against a real link, because a test that downloads from YouTube is a test that
 * fails when YouTube changes.
 */

import { describe, expect, it } from 'vitest';
import { parseYoutubeUrl, YOUTUBE_DOWNLOAD_DEFAULTS } from '@/media/youtube';
import { isAppError } from '@/lib/errors';

const reasonOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return isAppError(error) ? error.code : 'not-an-app-error';
  }
  return 'did-not-throw';
};

describe('parseYoutubeUrl', () => {
  const ID = 'dQw4w9WgXcQ';
  const canonical = `https://www.youtube.com/watch?v=${ID}`;

  it('accepts the shapes a link actually arrives in', () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/live/${ID}`,
    ]) {
      expect(parseYoutubeUrl(url)).toBe(canonical);
    }
  });

  it('drops playlist and tracking parameters', () => {
    // A link copied from a playlist should download what the user was watching,
    // not the forty videos after it.
    expect(parseYoutubeUrl(`https://www.youtube.com/watch?v=${ID}&list=PL123&index=4&t=42s&si=abc`)).toBe(canonical);
    expect(parseYoutubeUrl(`https://youtu.be/${ID}?si=tracking`)).toBe(canonical);
  });

  it('tolerates surrounding whitespace from a paste', () => {
    expect(parseYoutubeUrl(`  ${canonical}\n`)).toBe(canonical);
  });

  it('refuses hosts that are not YouTube', () => {
    // The reason this guard exists: a server that fetches any URL a caller names
    // will eventually be asked to fetch a link-local metadata endpoint.
    expect(reasonOf(() => parseYoutubeUrl('http://169.254.169.254/latest/meta-data/'))).toBe('unsupported_host');
    expect(reasonOf(() => parseYoutubeUrl('https://example.com/watch?v=dQw4w9WgXcQ'))).toBe('unsupported_host');
    expect(reasonOf(() => parseYoutubeUrl('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ'))).toBe('unsupported_host');
    expect(reasonOf(() => parseYoutubeUrl('https://notyoutube.com/watch?v=dQw4w9WgXcQ'))).toBe('unsupported_host');
  });

  it('refuses schemes that are not http', () => {
    expect(reasonOf(() => parseYoutubeUrl('file:///etc/passwd'))).toBe('invalid_url_scheme');
    expect(reasonOf(() => parseYoutubeUrl('ftp://youtube.com/watch?v=dQw4w9WgXcQ'))).toBe('invalid_url_scheme');
  });

  it('refuses a YouTube link that names no video', () => {
    expect(reasonOf(() => parseYoutubeUrl('https://www.youtube.com/'))).toBe('no_video_id');
    expect(reasonOf(() => parseYoutubeUrl('https://www.youtube.com/@somechannel'))).toBe('no_video_id');
    expect(reasonOf(() => parseYoutubeUrl('https://www.youtube.com/watch?v=tooshort'))).toBe('no_video_id');
  });

  it('refuses input that is not a URL at all', () => {
    expect(reasonOf(() => parseYoutubeUrl(''))).toBe('missing_url');
    expect(reasonOf(() => parseYoutubeUrl('   '))).toBe('missing_url');
    expect(reasonOf(() => parseYoutubeUrl('dQw4w9WgXcQ'))).toBe('invalid_url');
  });
});

describe('download limits', () => {
  it('bounds size, duration and wall clock', () => {
    // "Download this URL" is otherwise an unbounded promise on a laptop disk.
    expect(YOUTUBE_DOWNLOAD_DEFAULTS.maxBytes).toBeGreaterThan(0);
    expect(YOUTUBE_DOWNLOAD_DEFAULTS.maxDurationSec).toBeGreaterThan(0);
    expect(YOUTUBE_DOWNLOAD_DEFAULTS.timeoutMs).toBeGreaterThan(0);
    expect(YOUTUBE_DOWNLOAD_DEFAULTS.maxHeight).toBe(1080);
  });
});
