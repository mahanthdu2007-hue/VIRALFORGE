/**
 * Clip rendering.
 *
 * Turns one `ClipPlan` into one real video file by cutting the ranges it names
 * out of the source. This is the foundation of the render pipeline: it cuts,
 * and nothing else. No reframing, no subtitles, no effects — those phases layer
 * on through `RenderProfile` rather than by rewriting this component.
 *
 * Four properties are load-bearing:
 *
 *  1. **The source is never written to.** It is opened read-only by FFmpeg and
 *     is the input of every command here; no argument list names it as an
 *     output.
 *  2. **Nothing is buffered.** FFmpeg reads and writes files directly. This
 *     process only ever holds the plan and FFmpeg's textual stderr.
 *  3. **Timestamps are respected exactly.** Stream copy is used only where it
 *     provably lands on the requested frame; otherwise the clip is re-encoded.
 *     Speed never wins over cutting in the right place.
 *  4. **Failure leaves nothing behind.** All work happens in a temporary
 *     directory that is removed on success and on failure alike, and the
 *     output only appears at its final path once it is complete.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { nowIso, type ClipCut, type ClipPlan, type IsoTimestamp, type VideoAsset } from '@/domain';
import { isAppError, mediaError, renderingError, validationError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { runCommand } from './ffmpeg';
import type { MediaService } from './media-service';
import {
  buildConcatArgs,
  buildConcatListFile,
  buildCutArgs,
  buildKeyframeProbeArgs,
  decideRenderMode,
  parseKeyframeTimes,
  DEFAULT_RENDER_PROFILE,
  type RenderMode,
  type RenderProfile,
} from './clip-render';

/** What a completed render produced. Everything a caller needs to store or serve. */
export interface RenderedClip {
  /** Absolute path to the finished file. */
  readonly path: string;
  readonly sizeBytes: number;
  /** How the packets got here — useful when a render is unexpectedly slow. */
  readonly mode: RenderMode;
  /** Why that mode was chosen, e.g. `start_not_on_keyframe`. */
  readonly modeReason: string;
  /** Measured off the output by ffprobe, not assumed from the plan. */
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly hasAudio: boolean;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly containerFormat: string;
  readonly cutCount: number;
  readonly renderedAt: IsoTimestamp;
}

export interface ClipRenderRequest {
  /**
   * The uploaded source. Carries identity and probed metadata; its bytes are
   * addressed by `sourcePath`, which the caller resolves from the file store —
   * the media layer stays storage-agnostic, as it does for audio extraction.
   */
  readonly source: VideoAsset;
  /** Absolute path to the source file. Read-only throughout. */
  readonly sourcePath: string;
  readonly plan: ClipPlan;
  /** Absolute path the finished clip is moved to. */
  readonly outputPath: string;
  /**
   * Encoder settings and filter chain. Later phases pass a profile carrying a
   * reframing or subtitle filter; this phase's default carries neither.
   */
  readonly profile?: RenderProfile;
}

/**
 * The seam later phases build on.
 *
 * 9:16 reframing, subtitle burn-in and final encoding are all expressible as a
 * `RenderProfile`, so they arrive as new profiles and — where they need a
 * genuinely different strategy — as new implementations of this interface,
 * without this one changing.
 */
export interface ClipRenderer {
  /**
   * Render one plan to one file.
   *
   * @throws AppError kind=validation for a plan that does not describe a
   *         renderable range, kind=media when the source is unusable, and
   *         kind=rendering when FFmpeg itself fails.
   */
  render(request: ClipRenderRequest): Promise<RenderedClip>;
}

export interface ClipRendererOptions {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  /** Reads the finished file back. Reused so probing stays in one place. */
  readonly media: MediaService;
  /** Ceiling for one FFmpeg invocation. Encoding a 55s clip is not instant. */
  readonly commandTimeoutMs?: number;
  /**
   * Enforce the 15–55s hard limits on the plan's total duration.
   *
   * On by default: `validateClipPlans` already refuses a plan outside them, so
   * one arriving here means something upstream is wrong and a silently odd
   * render would hide it.
   */
  readonly enforceDurationLimits?: boolean;
  readonly logger?: Logger;
}

const DEFAULT_RENDER_TIMEOUT_MS = 10 * 60_000;

/** Hard limits on a renderable clip. Mirrors the domain's clip bounds. */
const MIN_RENDER_DURATION_SEC = 15;
const MAX_RENDER_DURATION_SEC = 55;

/** Float slack when comparing plan timestamps against a probed duration. */
const DURATION_EPSILON = 0.05;

export class FfmpegClipRenderer implements ClipRenderer {
  constructor(private readonly options: ClipRendererOptions) {}

  async render(request: ClipRenderRequest): Promise<RenderedClip> {
    const { plan, sourcePath, outputPath } = request;
    const profile = request.profile ?? DEFAULT_RENDER_PROFILE;

    const sourceDurationSec = await this.assertSourceUsable(sourcePath, request.source);
    const cuts = validateCuts(plan, sourceDurationSec, this.options.enforceDurationLimits !== false);

    await fsp.mkdir(path.dirname(outputPath), { recursive: true });

    // Alongside the output, so the final rename is a same-filesystem move
    // rather than a cross-device copy that can fail halfway.
    const tempDir = await fsp.mkdtemp(path.join(path.dirname(outputPath), '.render-'));

    try {
      const verdict = await this.chooseMode(sourcePath, cuts, profile, request.source);

      const tempOutput = path.join(tempDir, 'clip.mp4');
      if (cuts.length === 1) {
        await this.runFfmpeg(
          buildCutArgs({ sourcePath, outputPath: tempOutput, cut: cuts[0]!, mode: verdict.mode, profile }),
        );
      } else {
        await this.renderSegments(sourcePath, cuts, verdict.mode, profile, tempDir, tempOutput);
      }

      await assertProduced(tempOutput);

      // The output appears at its final path only now, complete. A consumer
      // watching the directory can never observe a half-written clip.
      await fsp.rename(tempOutput, outputPath);

      const [stats, metadata] = await Promise.all([
        fsp.stat(outputPath),
        this.options.media.probe(outputPath),
      ]);

      this.options.logger?.info('clip rendered', {
        clipPlanId: plan.id,
        mode: verdict.mode,
        reason: verdict.reason,
        durationSec: metadata.durationSec,
      });

      return {
        path: outputPath,
        sizeBytes: stats.size,
        mode: verdict.mode,
        modeReason: verdict.reason,
        durationSec: metadata.durationSec,
        width: metadata.width,
        height: metadata.height,
        fps: metadata.fps,
        hasAudio: metadata.hasAudio,
        videoCodec: metadata.videoCodec,
        audioCodec: metadata.audioCodec,
        containerFormat: metadata.containerFormat,
        cutCount: cuts.length,
        renderedAt: nowIso(),
      };
    } catch (error) {
      // A partial file at the destination would probe as corrupt media, so a
      // failed render must not leave one — even if the failure was the rename.
      await fsp.rm(outputPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      // Runs on both paths: segments and the staged output never outlive the call.
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Confirm the source is there and readable, and establish its duration.
   *
   * Prefers the already-probed metadata on the asset and falls back to probing,
   * so a caller that has not analysed the video yet is still validated.
   */
  private async assertSourceUsable(sourcePath: string, source: VideoAsset): Promise<number> {
    const stats = await fsp.stat(sourcePath).catch(() => null);

    if (!stats || !stats.isFile()) {
      throw mediaError('source_missing', 'The source video is missing or is not a file.', {
        details: { videoId: source.id },
        logDetails: { sourcePath },
      });
    }

    if (stats.size === 0) {
      throw mediaError('source_empty', 'The source video is empty.', {
        details: { videoId: source.id },
        logDetails: { sourcePath },
      });
    }

    const known = source.metadata?.durationSec;
    if (typeof known === 'number' && Number.isFinite(known) && known > 0) return known;

    return (await this.options.media.probe(sourcePath)).durationSec;
  }

  /**
   * Choose stream copy or re-encode for this render.
   *
   * The keyframe probe is the only reason this is async. A probe that fails is
   * not fatal: an empty keyframe list simply means copy cannot be proven safe,
   * and the decision falls through to re-encoding.
   */
  private async chooseMode(
    sourcePath: string,
    cuts: readonly ClipCut[],
    profile: RenderProfile,
    source: VideoAsset,
  ) {
    const keyframeTimesPerCut = await Promise.all(
      cuts.map((cut) => this.keyframesNear(sourcePath, cut.startSec)),
    );

    return decideRenderMode({
      cuts,
      profile,
      videoCodec: source.metadata?.videoCodec ?? null,
      audioCodec: source.metadata?.audioCodec ?? null,
      keyframeTimesPerCut,
    });
  }

  private async keyframesNear(sourcePath: string, atSec: number): Promise<number[]> {
    try {
      const { stdout } = await runCommand(
        this.options.ffprobePath,
        buildKeyframeProbeArgs(sourcePath, atSec),
        { timeoutMs: 30_000 },
      );
      return parseKeyframeTimes(stdout);
    } catch (error) {
      this.options.logger?.debug('keyframe probe failed; will re-encode', {
        atSec,
        error: String(error),
      });
      return [];
    }
  }

  /**
   * Render each cut to its own segment, then join them.
   *
   * Only reached by a multi-cut plan — every plan built today has one cut, but
   * the type permits trimming dead air out of the middle of a moment, and that
   * has to produce a single continuous file.
   */
  private async renderSegments(
    sourcePath: string,
    cuts: readonly ClipCut[],
    mode: RenderMode,
    profile: RenderProfile,
    tempDir: string,
    tempOutput: string,
  ): Promise<void> {
    const segmentPaths: string[] = [];

    // Sequential: two FFmpeg processes on one machine contend for the same
    // cores and disk, and finish no sooner than one after the other.
    for (const [index, cut] of cuts.entries()) {
      const segmentPath = path.join(tempDir, `segment-${String(index).padStart(3, '0')}.mp4`);
      await this.runFfmpeg(
        buildCutArgs({ sourcePath, outputPath: segmentPath, cut, mode, profile }),
      );
      await assertProduced(segmentPath);
      segmentPaths.push(segmentPath);
    }

    const listPath = path.join(tempDir, 'segments.txt');
    await fsp.writeFile(listPath, buildConcatListFile(segmentPaths), 'utf8');

    await this.runFfmpeg(buildConcatArgs({ listPath, outputPath: tempOutput, profile }));
  }

  /** Run FFmpeg, re-labelling any failure as a rendering error. */
  private async runFfmpeg(args: readonly string[]): Promise<void> {
    try {
      await runCommand(this.options.ffmpegPath, args, {
        timeoutMs: this.options.commandTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
      });
    } catch (error) {
      // A missing binary is a deployment fault, not a bad clip: it keeps its
      // own kind so the API layer reports it as such.
      if (isAppError(error) && error.code === 'toolchain_missing') throw error;

      throw renderingError('render_failed', 'FFmpeg failed to render the clip.', {
        cause: error,
        ...(isAppError(error) && error.details ? { details: error.details } : {}),
        logDetails: { args, ...(isAppError(error) ? error.logDetails : {}) },
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Check that a plan describes something renderable, and return its cuts.
 *
 * Rejects rather than repairs, exactly as plan validation does: a cut that runs
 * past the end of the source is a bug upstream, and quietly clamping it would
 * produce a clip whose speech does not match its transcript text.
 */
export function validateCuts(
  plan: Pick<ClipPlan, 'cuts' | 'id'>,
  sourceDurationSec: number,
  enforceDurationLimits = true,
): readonly ClipCut[] {
  const cuts = [...plan.cuts].sort((a, b) => a.order - b.order);

  const fail = (code: string, message: string, details: Record<string, unknown> = {}) =>
    validationError(code, message, { details: { clipPlanId: plan.id, ...details } });

  if (cuts.length === 0) throw fail('no_cuts', 'The plan has no cuts to render.');

  let previousEnd = -Infinity;
  let total = 0;

  for (const cut of cuts) {
    if (!Number.isFinite(cut.startSec) || !Number.isFinite(cut.endSec)) {
      throw fail('invalid_cut_range', 'A cut has a non-finite timestamp.', { cut });
    }

    if (cut.startSec < 0 || cut.endSec <= cut.startSec) {
      throw fail('invalid_cut_range', 'A cut is not a forward time range.', { cut });
    }

    if (cut.startSec < previousEnd) {
      throw fail('cuts_overlap', 'Cuts overlap; the rendered clip would repeat itself.', { cut });
    }

    if (cut.endSec > sourceDurationSec + DURATION_EPSILON) {
      throw fail('cut_outside_source', 'A cut ends past the end of the source video.', {
        cut,
        sourceDurationSec,
      });
    }

    previousEnd = cut.endSec;
    total += cut.endSec - cut.startSec;
  }

  if (enforceDurationLimits && (total < MIN_RENDER_DURATION_SEC || total > MAX_RENDER_DURATION_SEC)) {
    throw fail(
      'invalid_clip_duration',
      `Clip is ${total.toFixed(1)}s, outside the ${MIN_RENDER_DURATION_SEC}–${MAX_RENDER_DURATION_SEC}s limits.`,
      { durationSec: total },
    );
  }

  return cuts;
}

/** FFmpeg can exit 0 having written nothing usable; that must not pass as success. */
async function assertProduced(filePath: string): Promise<void> {
  const stats = await fsp.stat(filePath).catch(() => null);

  if (!stats || stats.size === 0) {
    throw renderingError('empty_render_output', 'FFmpeg produced no output file.', {
      logDetails: { filePath },
    });
  }
}
