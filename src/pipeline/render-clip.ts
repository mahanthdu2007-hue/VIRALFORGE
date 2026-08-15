/**
 * ClipPlan → rendered 9:16 clip.
 *
 * The composition the rest of the render phase is built from: take one
 * selected `ClipPlan`, ask a `SubjectTracker` where the subject is over the
 * plan's source range, turn that into a `CropPlan`, fold the crop plan and any
 * captions into a `RenderProfile`, and hand all of it to the existing
 * `FfmpegClipRenderer`. Every step already exists — tracking, crop-path maths,
 * reframing, subtitle documents, cutting — this module only wires them in the
 * right order.
 *
 * Two contracts this function upholds even though its collaborators already
 * promise them individually, because a broken clip is worse than a plain one:
 *
 *  - **Never fails the render for a tracking problem.** `SubjectTracker.track`
 *    is documented not to throw, and `buildCropPath` already turns "no usable
 *    observations" into a centre crop. This function additionally guards the
 *    call itself, so a tracker that violates its contract (or a frame source
 *    that throws before the tracker gets a chance to catch it) still ends in
 *    a rendered clip, not a failed job.
 *  - **The source is read-only throughout.** Tracking samples frames from it,
 *    the renderer cuts from it; neither step is permitted to write to it, and
 *    this module holds no state that would let one.
 *
 * Captions are optional and, when present, arrive as a finished `SubtitlePlan`
 * built by the caller from the transcript. This module writes that plan out as
 * an ASS document beside the output, because libass reads it *during* the
 * encode, and removes it on the way out whether the render worked or not.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  clipPlanSourceRange,
  SHORTS_OUTPUT,
  type ClipPlan,
  type CropPlan,
  type Dimensions,
  type SubtitlePlan,
  type VideoAsset,
} from '@/domain';
import type { Logger } from '@/lib/logger';
import { FfmpegClipRenderer, type RenderedClip } from '@/media/clip-renderer';
import type { MediaService } from '@/media/media-service';
import { withCropPlan } from '@/media/reframe';
import { withBurnedSubtitles } from '@/media/subtitle-burn';
import { renderAssDocument, type SubtitleStyle } from '@/subtitles';
import { DEFAULT_RENDER_PROFILE, type RenderProfile } from '@/media/clip-render';
import {
  buildCropPath,
  centerFallback,
  createSubjectTracker,
  type FrameSource,
  type SubjectTracker,
  type SubjectTrackerMode,
} from '@/tracking';

export interface RenderClipTrackingConfig {
  readonly mode: SubjectTrackerMode;
  /** Absolute path to the `.onnx` weights. Required by `face`, ignored otherwise. */
  readonly modelPath: string;
  readonly fps: number;
  readonly maxFrames: number;
  readonly maxEdgePx: number;
  readonly minConfidence: number;
}

export interface RenderClipDeps {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly media: MediaService;
  readonly tracking: RenderClipTrackingConfig;
  /**
   * Builds the frame source a detector mode reads pixels from, sized to the
   * source video. Injectable so tests can supply an in-memory source instead
   * of spawning FFmpeg; defaults to `FfmpegFrameSource` in the real runtime
   * wiring (`@/runtime`), which is what keeps this module free of a direct
   * dependency on the media layer's FFmpeg process code.
   */
  readonly frameSource?: (source: Dimensions) => FrameSource;
  readonly commandTimeoutMs?: number;
  /** Caption appearance. Geometry always comes from the plan's own layout. */
  readonly subtitleStyle?: SubtitleStyle;
  readonly logger?: Logger;
  /**
   * Skip tracker selection and use this tracker instead. Exists for tests: it
   * lets a fixture or fake tracker exercise the rest of the pipeline — crop
   * path, profile, render — without going through `SUBJECT_TRACKER` mode
   * resolution. Unused by the real runtime wiring (`@/runtime`).
   */
  readonly trackerOverride?: SubjectTracker;
}

export interface RenderClipPlanRequest {
  readonly source: VideoAsset;
  /** Absolute path to the source file. Read-only throughout. */
  readonly sourcePath: string;
  readonly plan: ClipPlan;
  /** Absolute path the finished clip is moved to. */
  readonly outputPath: string;
  /**
   * Captions to burn in, timed against the *clip* timeline. Built by the
   * caller from the transcript — this module never decides what the words are.
   * Omitted, or empty, renders the clip without captions rather than failing:
   * a Short with no burned text is still a Short.
   */
  readonly subtitles?: SubtitlePlan | null;
}

export interface RenderClipPlanResult {
  readonly rendered: RenderedClip;
  /** The crop plan actually used, tracked or fallen back to centre. */
  readonly profile: RenderProfile;
  readonly cropPlan: CropPlan;
  readonly trackerId: string;
  readonly trackerMode: SubjectTrackerMode;
  /** Captions actually burned in. Zero when none were supplied. */
  readonly cueCount: number;
}

/**
 * Render one `ClipPlan` end to end: track its subject, frame it, cut it.
 *
 * @throws AppError kind=media when the source has no usable dimensions,
 *         kind=validation for a plan the renderer cannot execute, and
 *         kind=rendering when FFmpeg itself fails. Tracking failures never
 *         reach the caller — they degrade to a centre crop instead.
 */
export async function renderClipPlan(
  deps: RenderClipDeps,
  request: RenderClipPlanRequest,
): Promise<RenderClipPlanResult> {
  const log = deps.logger?.child({ clipPlanId: request.plan.id });

  const sourceDims = await sourceDimensions(deps.media, request.source, request.sourcePath);
  const range = clipPlanSourceRange(request.plan);

  const frames = deps.frameSource?.(sourceDims);
  const selection = deps.trackerOverride
    ? { tracker: deps.trackerOverride, requested: deps.tracking.mode, mode: deps.tracking.mode }
    : await createSubjectTracker({
        mode: deps.tracking.mode,
        modelPath: deps.tracking.modelPath,
        fps: deps.tracking.fps,
        maxFrames: deps.tracking.maxFrames,
        maxEdgePx: deps.tracking.maxEdgePx,
        minConfidence: deps.tracking.minConfidence,
        ...(frames ? { frames } : {}),
        ...(log ? { logger: log } : {}),
      });

  log?.debug('subject tracker selected', {
    requested: selection.requested,
    mode: selection.mode,
    trackerId: selection.tracker.id,
  });

  const cropPlan = await trackedCropPlan(selection.tracker, {
    videoPath: request.sourcePath,
    range,
    source: sourceDims,
    minConfidence: deps.tracking.minConfidence,
    trackerId: selection.tracker.id,
    logger: log,
  });

  const cues = request.subtitles?.segments.length ? request.subtitles : null;

  // Beside the output, so the ASS file and the renderer's own staging directory
  // share a filesystem and neither depends on the system temp directory being
  // writable by whoever runs the server.
  await fsp.mkdir(path.dirname(request.outputPath), { recursive: true });
  const captionDir = cues ? await fsp.mkdtemp(path.join(path.dirname(request.outputPath), '.subs-')) : null;

  try {
    let profile = withCropPlan(DEFAULT_RENDER_PROFILE, cropPlan);

    if (cues && captionDir) {
      const assPath = path.join(captionDir, 'captions.ass');
      await fsp.writeFile(
        assPath,
        renderAssDocument(cues, deps.subtitleStyle),
        // UTF-8 without a BOM: libass reads a BOM as part of the first script
        // line and then finds no `[Script Info]` section.
        'utf8',
      );
      profile = withBurnedSubtitles(profile, assPath);
      log?.debug('captions prepared', { cues: cues.segments.length });
    }

    const renderer = new FfmpegClipRenderer({
      ffmpegPath: deps.ffmpegPath,
      ffprobePath: deps.ffprobePath,
      media: deps.media,
      ...(deps.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: deps.commandTimeoutMs }),
      ...(deps.logger ? { logger: deps.logger } : {}),
    });

    const rendered = await renderer.render({
      source: request.source,
      sourcePath: request.sourcePath,
      plan: request.plan,
      outputPath: request.outputPath,
      profile,
    });

    return {
      rendered,
      profile,
      cropPlan,
      trackerId: selection.tracker.id,
      trackerMode: selection.mode,
      cueCount: cues?.segments.length ?? 0,
    };
  } finally {
    // Runs on both paths: the document is an intermediate of this call and is
    // reproducible from the plan, so it never outlives the render.
    if (captionDir) {
      await fsp.rm(captionDir, { recursive: true, force: true }).catch((error: unknown) => {
        log?.warn('could not remove caption work directory', { error: String(error) });
      });
    }
  }
}

/* -------------------------------------------------------------------------- */

export interface TrackedCropPlanInput {
  readonly videoPath: string;
  readonly range: { readonly startSec: number; readonly endSec: number };
  readonly source: Dimensions;
  readonly minConfidence: number;
  readonly trackerId: string;
  readonly logger?: Pick<Logger, 'debug' | 'warn'>;
}

/**
 * Run the tracker and turn its observations into a crop plan, falling back to
 * a centre crop for any reason at all: no observations, all below the
 * confidence floor (both handled inside `buildCropPath` already), or the
 * tracker throwing outright despite its contract.
 */
export async function trackedCropPlan(tracker: SubjectTracker, input: TrackedCropPlanInput): Promise<CropPlan> {
  try {
    const result = await tracker.track({
      videoPath: input.videoPath,
      range: input.range,
      source: input.source,
    });

    return buildCropPath(result.observations, {
      source: input.source,
      output: SHORTS_OUTPUT,
      range: input.range,
      minConfidence: input.minConfidence,
      trackerId: result.trackerId,
    });
  } catch (error) {
    input.logger?.warn('subject tracking threw; falling back to centre crop', {
      tracker: input.trackerId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return centerFallback(input.source, SHORTS_OUTPUT, input.trackerId);
  }
}

/** The frame size tracking and cropping both need, preferring probed metadata. */
async function sourceDimensions(
  media: MediaService,
  source: VideoAsset,
  sourcePath: string,
): Promise<Dimensions> {
  const known = source.metadata;
  if (known && known.width > 0 && known.height > 0) {
    return { width: known.width, height: known.height };
  }

  const probed = await media.probe(sourcePath);
  return { width: probed.width, height: probed.height };
}
