/**
 * Thin process wrapper around the FFmpeg toolchain.
 *
 * All media work happens in child processes reading and writing files. Nothing
 * here buffers media: only FFmpeg's own textual output (version banners, probe
 * JSON) is ever captured, and that capture is bounded.
 */

import { execFile } from 'node:child_process';
import { mediaError } from '@/lib/errors';

/** ffprobe JSON for a long video is still only tens of KB. */
const MAX_TEXT_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

/**
 * Run a toolchain binary and capture its text output.
 * @throws AppError kind=media when the binary is missing or exits non-zero
 */
export function runCommand(bin: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...args],
      {
        maxBuffer: MAX_TEXT_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }

        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          reject(
            mediaError('toolchain_missing', `Executable not found: ${bin}`, {
              cause: error,
              details: { bin },
            }),
          );
          return;
        }

        // Absolute paths must not reach the client, but we still want them logged.
        const redact = pathRedactor(args);
        reject(
          mediaError('command_failed', `${bin} failed: ${redact(firstLine(stderr)) || error.message}`, {
            cause: error,
            details: { bin, exitCode: code ?? null, stderr: redact(tail(stderr)) },
            logDetails: { args, stderr: tail(stderr) },
          }),
        );
      },
    );
  });
}

export interface BinaryStatus {
  readonly path: string;
  readonly available: boolean;
  /** e.g. `8.1.1-essentials_build-www.gyan.dev`, or null when unavailable. */
  readonly version: string | null;
  readonly error: string | null;
}

export interface ToolchainStatus {
  readonly available: boolean;
  readonly ffmpeg: BinaryStatus;
  readonly ffprobe: BinaryStatus;
  readonly checkedAt: string;
}

/** Probes one binary with `-version`. Never throws: absence is a reportable state. */
async function checkBinary(binPath: string): Promise<BinaryStatus> {
  try {
    const { stdout } = await runCommand(binPath, ['-version'], { timeoutMs: 10_000 });
    return { path: binPath, available: true, version: parseVersion(stdout), error: null };
  } catch (error) {
    return {
      path: binPath,
      available: false,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Whether FFmpeg and ffprobe are usable, and at which versions. */
export async function detectToolchain(paths: {
  ffmpegPath: string;
  ffprobePath: string;
}): Promise<ToolchainStatus> {
  const [ffmpeg, ffprobe] = await Promise.all([
    checkBinary(paths.ffmpegPath),
    checkBinary(paths.ffprobePath),
  ]);

  return {
    available: ffmpeg.available && ffprobe.available,
    ffmpeg,
    ffprobe,
    checkedAt: new Date().toISOString(),
  };
}

/** Extracts the version token from an FFmpeg `-version` banner. */
export function parseVersion(banner: string): string | null {
  return /^(?:ffmpeg|ffprobe) version (\S+)/im.exec(banner)?.[1] ?? null;
}

const firstLine = (text: string): string => text.split(/\r?\n/, 1)[0]?.trim() ?? '';
const tail = (text: string): string => text.slice(-2000);

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/;

/**
 * Builds a function that rewrites any absolute path we passed as an argument
 * down to its basename, wherever it appears in FFmpeg's output.
 */
export function pathRedactor(args: readonly string[]): (text: string) => string {
  const paths = args.filter((arg) => ABSOLUTE_PATH.test(arg));

  return (text: string) =>
    paths.reduce((acc, full) => {
      const base = full.slice(Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\')) + 1);
      return acc.split(full).join(base);
    }, text);
}
