/**
 * Media engine facade.
 *
 * The rest of the app talks to `MediaService` and never to FFmpeg directly.
 * Every operation is a bounded subprocess over files on disk: the process never
 * holds video or audio in memory.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { detectToolchain, runCommand, type ToolchainStatus } from './ffmpeg';
import { parseProbeOutput, type ProbeOutput } from './probe';
import { buildExtractAudioArgs, DEFAULT_AUDIO_SPEC } from './audio';
import { isAppError, mediaError } from '@/lib/errors';
import type { MediaMetadata } from '@/domain';
import type { AudioSpec } from '@/ai/types';

export interface ExtractedAudio {
  readonly path: string;
  readonly sizeBytes: number;
  readonly spec: AudioSpec;
}

export interface MediaService {
  /** Are FFmpeg and ffprobe usable? Cached after the first successful check. */
  toolchain(): Promise<ToolchainStatus>;
  /**
   * Read duration, resolution, FPS, codecs and audio presence off a file.
   * @param absolutePath file on disk; never read into memory
   */
  probe(absolutePath: string): Promise<MediaMetadata>;
  /**
   * Decode the first audio stream of `videoPath` into `outputPath`.
   *
   * The source is left untouched. A failed or empty extraction removes the
   * partial output before throwing, so no half-written file can be transcribed.
   *
   * @throws AppError kind=media on a missing audio stream or an FFmpeg failure
   */
  extractAudio(videoPath: string, outputPath: string, spec?: AudioSpec): Promise<ExtractedAudio>;
}

export interface MediaServiceOptions {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  /** Ceiling for a single FFmpeg invocation. Extraction on long videos is slow. */
  readonly commandTimeoutMs?: number;
}

export class FfmpegMediaService implements MediaService {
  private cachedToolchain: ToolchainStatus | null = null;

  constructor(private readonly options: MediaServiceOptions) {}

  async toolchain(): Promise<ToolchainStatus> {
    // Re-check while unavailable so installing FFmpeg does not require a restart.
    if (this.cachedToolchain?.available) return this.cachedToolchain;
    this.cachedToolchain = await detectToolchain(this.options);
    return this.cachedToolchain;
  }

  async probe(absolutePath: string): Promise<MediaMetadata> {
    const { stdout } = await runCommand(this.options.ffprobePath, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      absolutePath,
    ]);

    let parsed: ProbeOutput;
    try {
      parsed = JSON.parse(stdout) as ProbeOutput;
    } catch (error) {
      throw mediaError('probe_unparseable', 'ffprobe returned output that could not be parsed.', {
        cause: error,
        details: { path: absolutePath },
      });
    }

    return parseProbeOutput(parsed);
  }

  async extractAudio(
    videoPath: string,
    outputPath: string,
    spec: AudioSpec = DEFAULT_AUDIO_SPEC,
  ): Promise<ExtractedAudio> {
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });

    try {
      await runCommand(this.options.ffmpegPath, buildExtractAudioArgs(videoPath, outputPath, spec), {
        ...(this.options.commandTimeoutMs ? { timeoutMs: this.options.commandTimeoutMs } : {}),
      });
    } catch (error) {
      await removeQuietly(outputPath);

      // FFmpeg reports an unmatched `-map 0:a:0` this way. That is a property of
      // the file, not a toolchain fault, so it earns its own code. Matched
      // against the captured stderr rather than the summary message, which only
      // carries the first line.
      const stderr = isAppError(error) ? String(error.logDetails?.stderr ?? '') : '';
      if (/matches no streams|does not contain any stream/i.test(stderr)) {
        throw mediaError('no_audio_stream', 'The video has no audio track to transcribe.', {
          cause: error,
          logDetails: { stderr },
        });
      }
      throw error;
    }

    const stats = await fsp.stat(outputPath).catch(() => null);
    if (!stats || stats.size === 0) {
      await removeQuietly(outputPath);
      throw mediaError('empty_audio_output', 'Audio extraction produced no data.', {
        details: { format: spec.format },
      });
    }

    return { path: outputPath, sizeBytes: stats.size, spec };
  }
}

const removeQuietly = (target: string): Promise<void> =>
  fsp.rm(target, { force: true }).catch(() => undefined);
