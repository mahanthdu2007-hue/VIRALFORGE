/**
 * A `SubjectTracker` built out of a frame source, a detector and association.
 *
 * This is the only new implementation of the phase's original abstraction — the
 * interface, the crop path and the deterministic trackers are untouched, which
 * was the point of splitting them in the first place. What it adds is the
 * plumbing between three things that each know nothing about the others:
 * frames come from a `FrameSource`, boxes from a `FrameDetector`, and the choice
 * of subject from `trackPrimarySubject`.
 *
 * Two contracts are inherited from `SubjectTracker` and are the reason this
 * class is mostly error handling:
 *
 *  - **It must not throw for footage it cannot handle.** A missing model, a
 *    codec FFmpeg dislikes, a video with nobody in it — all of them come back as
 *    an empty observation list, and `buildCropPath` turns that into a centre
 *    crop. Nothing about a run should fail because subject detection was
 *    ambitious.
 *  - **The work is bounded before it starts.** Frames per second and a hard
 *    frame ceiling are settings, not consequences: a ten-minute range costs the
 *    same as a one-minute range once the ceiling binds.
 *
 * The detector's lifetime belongs to whoever constructed it. This class never
 * closes it, because the expensive thing — a loaded model — should outlive a
 * single clip.
 */

import type { Dimensions } from '@/domain';
import type { Logger } from '@/lib/logger';
import { trackPrimarySubject, type AssociateOptions } from './detection/associate';
import type { FrameSource } from './detection/frame-source';
import type { DetectionFrame, FrameDetection, FrameDetector } from './detection/types';
import type { SubjectTracker, TrackingRequest, TrackingResult } from './types';

export interface DetectorSubjectTrackerOptions {
  readonly detector: FrameDetector;
  readonly frames: FrameSource;
  /** Frames sampled per second of source. Two is ample for framing a talker. */
  readonly fps?: number;
  /** Hard ceiling on frames per `track` call, whatever the range's length. */
  readonly maxFrames?: number;
  /** Longest edge of a decoded frame. Detection accuracy plateaus well below HD. */
  readonly maxEdgePx?: number;
  /** Association tuning. `source` comes from the request. */
  readonly association?: Omit<AssociateOptions, 'source'>;
  readonly logger?: Pick<Logger, 'debug' | 'warn'>;
  /** Overrides the derived `detector:<id>` provenance string. */
  readonly id?: string;
}

export const DETECTOR_TRACKER_DEFAULTS = {
  fps: 2,
  maxFrames: 240,
  maxEdgePx: 640,
} as const;

export class DetectorSubjectTracker implements SubjectTracker {
  readonly id: string;

  constructor(private readonly options: DetectorSubjectTrackerOptions) {
    this.id = options.id ?? `detector:${options.detector.id}`;
  }

  async track(request: TrackingRequest): Promise<TrackingResult> {
    const empty: TrackingResult = { observations: [], trackerId: this.id };

    const durationSec = request.range.endSec - request.range.startSec;
    if (!(durationSec > 0) || !usableSource(request.source)) return empty;

    // `intervalSec` is the caller saying how often it wants observations; it
    // outranks the configured rate, since sampling faster than that is work
    // whose result the crop path immediately resamples away.
    const fps = request.intervalSec && request.intervalSec > 0 ? 1 / request.intervalSec : this.fps;
    const maxFrames = Math.max(1, Math.min(this.maxFrames, Math.ceil(durationSec * fps) + 1));

    try {
      const detected = await this.detectFrames(request, fps, maxFrames);
      const observations = trackPrimarySubject(detected, {
        source: request.source,
        ...(this.options.association ?? {}),
      });

      this.options.logger?.debug('subject tracking finished', {
        tracker: this.id,
        frames: detected.length,
        detections: detected.reduce((total, frame) => total + frame.detections.length, 0),
        observations: observations.length,
      });

      return { observations, trackerId: this.id };
    } catch (error) {
      // Deliberately swallowed: see the class comment. Logged at warn because a
      // detector that cannot run is worth knowing about even though the run
      // continues with a centre crop.
      this.options.logger?.warn('subject tracking failed; falling back to centre crop', {
        tracker: this.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }
  }

  /**
   * Decode, detect, and put the boxes back into source pixels.
   *
   * Frames are consumed one at a time and dropped as soon as they are detected
   * on — the frame source only produces the next one once this loop asks — so
   * the loop holds one frame, not the range.
   */
  private async detectFrames(
    request: TrackingRequest,
    fps: number,
    maxFrames: number,
  ): Promise<readonly DetectionFrame[]> {
    const frames: DetectionFrame[] = [];

    for await (const sample of this.options.frames.frames({
      videoPath: request.videoPath,
      startSec: request.range.startSec,
      endSec: request.range.endSec,
      fps,
      maxFrames,
      maxEdgePx: this.maxEdgePx,
    })) {
      const detections = await this.options.detector.detect(sample.frame);
      frames.push({
        atSec: sample.atSec,
        detections: detections
          .map((detection) => toSourceCoordinates(detection, sample.frame, request.source))
          .filter((detection): detection is FrameDetection => detection !== null),
      });
    }

    return frames;
  }

  private get fps(): number {
    const configured = this.options.fps;
    return typeof configured === 'number' && configured > 0 ? configured : DETECTOR_TRACKER_DEFAULTS.fps;
  }

  private get maxFrames(): number {
    const configured = this.options.maxFrames;
    return typeof configured === 'number' && configured >= 1
      ? Math.floor(configured)
      : DETECTOR_TRACKER_DEFAULTS.maxFrames;
  }

  private get maxEdgePx(): number {
    const configured = this.options.maxEdgePx;
    return typeof configured === 'number' && configured > 0
      ? configured
      : DETECTOR_TRACKER_DEFAULTS.maxEdgePx;
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Rescale a box from the decoded frame to the source frame, and clip it.
 *
 * Detection runs on a downscaled picture but every consumer downstream — the
 * crop window, the render — works in source pixels, so this conversion is the
 * point at which "inside the frame" becomes a property the rest of the system
 * can rely on. Clipping happens here rather than being trusted from the
 * detector: a box hanging off the edge is normal for a subject walking out, and
 * `isUsableObservation` would otherwise reject the whole observation.
 */
export function toSourceCoordinates(
  detection: FrameDetection,
  frame: { readonly width: number; readonly height: number },
  source: Dimensions,
): FrameDetection | null {
  if (!(frame.width > 0) || !(frame.height > 0)) return null;

  const scaleX = source.width / frame.width;
  const scaleY = source.height / frame.height;

  const left = Math.max(0, detection.x * scaleX);
  const top = Math.max(0, detection.y * scaleY);
  const right = Math.min(source.width, (detection.x + detection.width) * scaleX);
  const bottom = Math.min(source.height, (detection.y + detection.height) * scaleY);

  const width = right - left;
  const height = bottom - top;
  if (!(width > 0) || !(height > 0)) return null;

  return {
    x: round3(left),
    y: round3(top),
    width: round3(width),
    height: round3(height),
    confidence: detection.confidence,
  };
}

const usableSource = (source: Dimensions): boolean =>
  Number.isFinite(source.width) && Number.isFinite(source.height) && source.width > 0 && source.height > 0;

const round3 = (value: number): number => Math.round(value * 1e3) / 1e3;
