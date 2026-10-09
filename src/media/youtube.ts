/**
 * A YouTube URL → a file on disk the rest of the pipeline can treat as an upload.
 *
 * Downloading is delegated to `yt-dlp` rather than reimplemented. YouTube's
 * player changes on their schedule, not ours, and every in-house extractor
 * becomes a maintenance burden the week after it ships; yt-dlp is the tool that
 * tracks those changes, and treating it as an optional external binary is the
 * same bargain this project already makes with FFmpeg.
 *
 * Three things this module is careful about:
 *
 *  1. **Only YouTube.** The URL is parsed and its host checked against a fixed
 *     list before it reaches a subprocess. A server that will fetch any URL a
 *     caller names is a server that will fetch a link-local metadata endpoint,
 *     and the argument is not worth having in a video tool.
 *  2. **Bounded.** A size cap, a duration cap and a wall-clock timeout, because
 *     "download this URL" is otherwise an unbounded promise on a laptop disk.
 *  3. **Absent is not broken.** No yt-dlp means a clear, actionable error naming
 *     the install command — not a stack trace from a missing binary.
 *
 * The downloaded file is left where the caller asked for it; ownership passes
 * to them, exactly as an uploaded file's does.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mediaError, validationError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';

/** Hosts a source URL may name. Anything else is refused before we spawn. */
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

export const YOUTUBE_DOWNLOAD_DEFAULTS = {
  /** Ceiling on the stored file. Matched to the upload limit by the caller. */
  maxBytes: 2 * 1024 * 1024 * 1024,
  /** Sources longer than this are refused: the pipeline is built for talks, not films. */
  maxDurationSec: 4 * 60 * 60,
  /** Wall clock for the whole download. */
  timeoutMs: 30 * 60 * 1000,
  /** Tallest video accepted. Shorts render at 1920 tall; more is wasted bytes. */
  maxHeight: 1080,
} as const;

export interface YoutubeDownloadRequest {
  readonly url: string;
  /** Directory the file is written into. Created if missing. */
  readonly directory: string;
  /** Filename stem. The extension is decided by the merge format. */
  readonly basename: string;
  readonly maxBytes?: number;
  readonly maxDurationSec?: number;
  readonly timeoutMs?: number;
  readonly logger?: Pick<Logger, 'debug' | 'info' | 'warn'>;
}

export interface YoutubeDownload {
  readonly filePath: string;
  /** The video's own title, for `originalFilename`. */
  readonly title: string;
  readonly durationSec: number;
  readonly sizeBytes: number;
  readonly webpageUrl: string;
}

/**
 * Is this a URL we are willing to fetch, and what is its canonical form?
 *
 * Returns the URL to hand to yt-dlp, with tracking and playlist parameters
 * dropped — a link copied out of a playlist should download the video the user
 * was watching, not the forty after it.
 */
export function parseYoutubeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw validationError('missing_url', 'No URL was given.');

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw validationError('invalid_url', 'That is not a URL. Paste the full link, including https://.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw validationError('invalid_url_scheme', 'Only http and https links can be downloaded.');
  }

  if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw validationError('unsupported_host', `Only YouTube links are supported; this one points at ${parsed.hostname}.`);
  }

  const id = videoIdOf(parsed);
  if (!id) {
    throw validationError('no_video_id', 'That YouTube link does not name a video.');
  }

  return `https://www.youtube.com/watch?v=${id}`;
}

function videoIdOf(url: URL): string | null {
  if (url.hostname.toLowerCase().endsWith('youtu.be')) {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && ID_PATTERN.test(id) ? id : null;
  }

  const direct = url.searchParams.get('v');
  if (direct && ID_PATTERN.test(direct)) return direct;

  // /shorts/<id>, /embed/<id>, /live/<id>
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(parts[0]!.toLowerCase())) {
    return ID_PATTERN.test(parts[1]!) ? parts[1]! : null;
  }

  return null;
}

const ID_PATTERN = /^[\w-]{11}$/u;

/**
 * Fetch the video, or say why not.
 *
 * @throws AppError kind=validation for a URL we will not fetch, kind=media when
 *         yt-dlp is missing, fails, or the source breaks a limit.
 */
export async function downloadYoutubeVideo(request: YoutubeDownloadRequest): Promise<YoutubeDownload> {
  const url = parseYoutubeUrl(request.url);
  const maxBytes = request.maxBytes ?? YOUTUBE_DOWNLOAD_DEFAULTS.maxBytes;
  const maxDurationSec = request.maxDurationSec ?? YOUTUBE_DOWNLOAD_DEFAULTS.maxDurationSec;
  const timeoutMs = request.timeoutMs ?? YOUTUBE_DOWNLOAD_DEFAULTS.timeoutMs;

  const command = await resolveYtDlp();
  await fsp.mkdir(request.directory, { recursive: true });

  const output = path.join(request.directory, `${request.basename}.%(ext)s`);
  const args = [
    ...command.leading,
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    // Restricts what a malicious title can do to the filesystem; the real title
    // is read back from the JSON dump rather than from the filename.
    '--restrict-filenames',
    '--no-part',
    '--max-filesize', String(maxBytes),
    '--match-filter', `duration < ${maxDurationSec}`,
    '--merge-output-format', 'mp4',
    // MP4 and M4A first, and the order is not cosmetic. Left to its own
    // preferences yt-dlp picks WebM audio, and those streams answered the
    // download request with HTTP 403 on a link whose MP4 equivalents fetched
    // fine. Preferring the MP4 family also hands FFmpeg H.264/AAC, which is what
    // the renderer wants anyway. The bare fallbacks stay so an unusual source
    // still downloads rather than failing on format selection.
    '-f', formatSelector(YOUTUBE_DOWNLOAD_DEFAULTS.maxHeight),
    '--print-json',
    '-o', output,
    url,
  ];

  request.logger?.info('downloading source from youtube', { url, maxBytes, maxDurationSec });

  const result = await run(command.executable, args, timeoutMs);
  if (result.code !== 0) {
    throw mediaError('youtube_download_failed', describeFailure(result.stderr), {
      details: { url, exitCode: result.code },
    });
  }

  const info = parseInfoJson(result.stdout);
  if (!info) {
    throw mediaError('youtube_download_failed', 'yt-dlp finished without reporting what it downloaded.', {
      details: { url },
    });
  }

  const filePath = await locateOutput(request.directory, request.basename, info.filename);
  const stats = await fsp.stat(filePath).catch(() => null);
  if (!stats?.isFile()) {
    throw mediaError('youtube_download_failed', 'The download reported success but produced no file.', {
      details: { url },
    });
  }

  if (stats.size > maxBytes) {
    await fsp.rm(filePath, { force: true });
    throw mediaError('youtube_video_too_large', `The video is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  }

  request.logger?.info('youtube source downloaded', {
    title: info.title,
    durationSec: info.duration,
    sizeBytes: stats.size,
  });

  return {
    filePath,
    title: info.title || 'YouTube video',
    durationSec: info.duration ?? 0,
    sizeBytes: stats.size,
    webpageUrl: info.webpage_url || url,
  };
}

/* -------------------------------------------------------------------------- */

/** Format preference, best-supported container first. Exported so a test can pin it. */
export const formatSelector = (maxHeight: number): string =>
  [
    `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]`,
    `b[height<=${maxHeight}][ext=mp4]`,
    `b[height<=${maxHeight}]`,
    'b',
  ].join('/');

interface YtDlpCommand {
  readonly executable: string;
  /** Arguments before ours, for the `python -m yt_dlp` form. */
  readonly leading: readonly string[];
  readonly label: string;
}

/**
 * Where yt-dlp lives, if anywhere.
 *
 * `pip install yt-dlp` frequently lands the console script somewhere off PATH
 * while the module itself imports perfectly, so the module form is tried too
 * rather than telling a user with a working install that they do not have one.
 */
export async function resolveYtDlp(): Promise<YtDlpCommand> {
  const configured = process.env.YTDLP_PATH?.trim();
  const candidates: YtDlpCommand[] = configured
    ? [{ executable: configured, leading: [], label: configured }]
    : [
        { executable: 'yt-dlp', leading: [], label: 'yt-dlp' },
        { executable: 'python', leading: ['-m', 'yt_dlp'], label: 'python -m yt_dlp' },
        { executable: 'python3', leading: ['-m', 'yt_dlp'], label: 'python3 -m yt_dlp' },
      ];

  for (const candidate of candidates) {
    const probe = await run(candidate.executable, [...candidate.leading, '--version'], 20_000).catch(() => null);
    if (probe && probe.code === 0) return candidate;
  }

  throw mediaError(
    'youtube_downloader_missing',
    'Downloading from YouTube needs yt-dlp, which is not installed. Install it with "pip install yt-dlp", ' +
      'or set YTDLP_PATH to the executable.',
  );
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(executable: string, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(mediaError('youtube_download_timeout', `The download did not finish within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded: yt-dlp can be chatty on a failing extractor and this is only
      // ever read to build one error message.
      if (stderr.length < 8000) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) resolve({ code, stdout, stderr });
    });
  });
}

interface InfoJson {
  readonly title?: string;
  readonly duration?: number;
  readonly filename?: string;
  readonly webpage_url?: string;
}

/** The last JSON object yt-dlp printed. Earlier lines describe merged formats. */
function parseInfoJson(stdout: string): InfoJson | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'));

  for (const line of lines.reverse()) {
    try {
      return JSON.parse(line) as InfoJson;
    } catch {
      // Not the JSON dump; keep looking backwards.
    }
  }

  return null;
}

/**
 * The file that was actually written.
 *
 * yt-dlp reports the filename it *planned*, which is the pre-merge extension
 * when it had to mux two streams, so the directory is the authority. Matching on
 * our own basename is what keeps a stale sibling from being picked up.
 */
async function locateOutput(directory: string, basename: string, reported: string | undefined): Promise<string> {
  if (reported) {
    const candidate = path.isAbsolute(reported) ? reported : path.join(directory, path.basename(reported));
    if (await exists(candidate)) return candidate;

    const merged = candidate.replace(/\.[^.]+$/u, '.mp4');
    if (await exists(merged)) return merged;
  }

  const entries = await fsp.readdir(directory).catch(() => [] as string[]);
  const match = entries.find((entry) => entry.startsWith(`${basename}.`));
  if (match) return path.join(directory, match);

  throw mediaError('youtube_download_failed', 'The download produced no file that could be found.');
}

const exists = (target: string): Promise<boolean> =>
  fsp.stat(target).then(
    (s) => s.isFile(),
    () => false,
  );

/** yt-dlp's own diagnosis, reduced to the line a user can act on. */
function describeFailure(stderr: string): string {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('ERROR:'));

  if (!line) return 'yt-dlp could not download that video.';

  const message = line.replace(/^ERROR:\s*/u, '');
  if (/private video/iu.test(message)) return 'That video is private.';
  if (/members-only|join this channel/iu.test(message)) return 'That video is members-only.';
  if (/sign in to confirm|age/iu.test(message)) return 'That video is age-restricted and cannot be downloaded anonymously.';
  if (/unavailable/iu.test(message)) return 'That video is unavailable.';
  if (/does not pass filter/iu.test(message)) return 'That video is longer than this tool accepts.';

  return `yt-dlp could not download that video: ${message}`;
}
