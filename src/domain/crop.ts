import type { TimeRange } from './common';
import { SHORTS_OUTPUT_HEIGHT, SHORTS_OUTPUT_WIDTH } from './video';

/**
 * How the 16:9 (or arbitrary) source is reduced to a 9:16 frame.
 *
 * `static` picks one window for the whole clip; `tracked` moves the window over
 * time using keyframes; `letterbox` keeps the full width and pads. The renderer
 * interpolates linearly between keyframes.
 */
export type CropStrategy = 'static' | 'tracked' | 'letterbox';

/** Integer pixel size. Used for both the source frame and the output frame. */
export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/** A rectangle in source pixel coordinates. The origin is the top-left corner. */
export interface CropWindow {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A crop window in source pixel coordinates at one instant. */
export interface CropKeyframe extends CropWindow {
  /** Seconds on the *clip* timeline, not the source timeline. */
  readonly atSec: number;
  /**
   * How much the framing at this instant was actually driven by a tracked
   * subject: 1 when a confident observation placed it, 0 when it fell back to
   * the centre. Null on a plan that was never tracked. Diagnostic only — the
   * geometry is already resolved.
   */
  readonly confidence?: number | null;
  /** Which subject the window is following, when the tracker distinguishes them. */
  readonly subjectId?: string | null;
}

/**
 * How a source frame becomes a 9:16 frame — without ever modifying the source.
 *
 * A plan is a description, not an operation: it names the source it was
 * computed against, the output frame it targets, and the window(s) of the
 * source that fill that frame. The renderer turns it into an FFmpeg filter; the
 * source file is only ever read.
 *
 * A `static` plan carries exactly one keyframe. The `keyframes` list is also
 * the seam for future subject tracking: a `tracked` plan carries several and
 * the window moves between them. Nothing in this phase produces one.
 */
export interface CropPlan {
  readonly strategy: CropStrategy;
  /** Dimensions of the frame the windows are expressed in. */
  readonly source: Dimensions;
  /** The finished frame, e.g. 1080×1920. Always the target aspect ratio. */
  readonly output: Dimensions;
  /** Target ratio as width/height, e.g. 0.5625 for 9:16. */
  readonly targetAspectRatio: number;
  /** At least one; ordered by `atSec`. A `static` plan has exactly one. */
  readonly keyframes: readonly CropKeyframe[];
  /** Why the framing looks like this — surfaced in the UI for transparency. */
  readonly rationale: string | null;
}

/* -------------------------------------------------------------------------- */
/* Geometry — pure, integer-only, no I/O.                                     */
/* -------------------------------------------------------------------------- */

/** Why a crop could not be planned. Mapped to an `AppError` at the media seam. */
export type CropFailureReason =
  /** Source width/height is not a positive integer. */
  | 'invalid_source_dimensions'
  /** Requested output width/height is not a positive integer. */
  | 'invalid_output_dimensions'
  /** No window of the target ratio fits inside the source at even pixel sizes. */
  | 'source_too_small';

export type CropPlanResult =
  | { readonly ok: true; readonly plan: CropPlan }
  | { readonly ok: false; readonly reason: CropFailureReason };

/** The default finished frame: a full-resolution Short. */
export const SHORTS_OUTPUT: Dimensions = {
  width: SHORTS_OUTPUT_WIDTH,
  height: SHORTS_OUTPUT_HEIGHT,
};

export const isValidDimensions = (dimensions: Dimensions): boolean =>
  Number.isInteger(dimensions.width) &&
  Number.isInteger(dimensions.height) &&
  dimensions.width > 0 &&
  dimensions.height > 0;

export const aspectRatio = (dimensions: Dimensions | CropWindow): number =>
  dimensions.width / dimensions.height;

/** Whether the window lies wholly inside a frame of `source` size. */
export const cropWindowFits = (window: CropWindow, source: Dimensions): boolean =>
  window.x >= 0 &&
  window.y >= 0 &&
  window.width > 0 &&
  window.height > 0 &&
  window.x + window.width <= source.width &&
  window.y + window.height <= source.height;

export interface CenterCropInput {
  readonly source: Dimensions;
  /** Defaults to 1080×1920. Its ratio is the ratio the crop window will have. */
  readonly output?: Dimensions;
  readonly rationale?: string | null;
}

/**
 * The largest centred window of the output's aspect ratio that fits the source.
 *
 * Two properties make this worth stating, because they are what "do not stretch
 * the video" actually requires:
 *
 *  1. **The window's ratio equals the output's ratio exactly.** Not to within a
 *     rounding error — exactly. The window is built as an integer multiple of
 *     the output ratio in lowest terms (9:16 → multiples of 18×32), so scaling
 *     it to the output is uniform in both axes. Taking the naive maximum
 *     instead (1080-high source → 607.5px wide, rounded to 606) would leave the
 *     scale step stretching by a quarter of a percent, which is exactly the
 *     kind of "nearly right" that survives review and shows up on faces.
 *  2. **Every number is even.** Chroma in yuv420p is subsampled 2×2, so odd
 *     widths, heights or offsets have no well-defined chroma plane; FFmpeg
 *     either refuses or silently rounds. The 18×32 step keeps sizes even, and
 *     offsets are floored to even.
 *
 * The cost is up to 31 discarded rows and 17 discarded columns versus the naive
 * maximum — under 3% on any realistic source, and never a stretched pixel.
 *
 * Deterministic: the same source and output always yield the same window.
 */
export function planCenterCrop(input: CenterCropInput): CropPlanResult {
  const { source } = input;
  const output = input.output ?? SHORTS_OUTPUT;

  if (!isValidDimensions(source)) return { ok: false, reason: 'invalid_source_dimensions' };
  if (!isValidDimensions(output)) return { ok: false, reason: 'invalid_output_dimensions' };

  const window = largestCenteredWindow(source, output);
  if (!window) return { ok: false, reason: 'source_too_small' };

  return {
    ok: true,
    plan: {
      strategy: 'static',
      source: { width: source.width, height: source.height },
      output: { width: output.width, height: output.height },
      targetAspectRatio: aspectRatio(output),
      keyframes: [{ atSec: 0, ...window }],
      rationale: input.rationale ?? null,
    },
  };
}

/** The window `planCenterCrop` is built on. Null when nothing of the ratio fits. */
export function largestCenteredWindow(
  source: Dimensions,
  output: Dimensions,
): CropWindow | null {
  const step = evenRatioStep(output);

  // How many whole ratio steps fit in each axis; the smaller axis decides.
  const scale = Math.min(
    Math.floor(source.width / step.width),
    Math.floor(source.height / step.height),
  );
  if (scale < 1) return null;

  const width = step.width * scale;
  const height = step.height * scale;

  return {
    x: evenFloor((source.width - width) / 2),
    y: evenFloor((source.height - height) / 2),
    width,
    height,
  };
}

/**
 * Move a window wholly inside a frame, keeping its size.
 *
 * Offsets are floored to even for the same chroma reason as everywhere else. A
 * window larger than the frame is pinned at the origin rather than shrunk:
 * resizing it would change the aspect ratio, which is never the right repair.
 */
export function clampCropWindow(window: CropWindow, source: Dimensions): CropWindow {
  const x = evenFloor(clamp(window.x, 0, Math.max(0, source.width - window.width)));
  const y = evenFloor(clamp(window.y, 0, Math.max(0, source.height - window.height)));
  return { ...window, x, y };
}

/**
 * The window a tracked plan shows at one instant on the clip timeline.
 *
 * Linear between keyframes, held flat before the first and after the last —
 * the behaviour the `CropPlan` docs have promised since the type was written,
 * now executable. A `static` plan returns its single window at every time.
 */
export function cropWindowAt(plan: CropPlan, atSec: number): CropWindow {
  const frames = plan.keyframes;
  const first = frames[0];
  if (!first) throw new Error('cropWindowAt: the plan has no keyframes');

  const last = frames[frames.length - 1]!;
  if (atSec <= first.atSec) return toWindow(first);
  if (atSec >= last.atSec) return toWindow(last);

  for (let i = 1; i < frames.length; i += 1) {
    const to = frames[i]!;
    if (atSec > to.atSec) continue;

    const from = frames[i - 1]!;
    const span = to.atSec - from.atSec;
    // Coincident keyframes would divide by zero; the later one wins.
    const t = span > 0 ? (atSec - from.atSec) / span : 1;

    return {
      x: evenFloor(lerp(from.x, to.x, t)),
      y: evenFloor(lerp(from.y, to.y, t)),
      width: evenFloor(lerp(from.width, to.width, t)),
      height: evenFloor(lerp(from.height, to.height, t)),
    };
  }

  return toWindow(last);
}

const toWindow = (frame: CropKeyframe): CropWindow => ({
  x: frame.x,
  y: frame.y,
  width: frame.width,
  height: frame.height,
});

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * The output ratio in lowest terms, doubled if needed so both terms are even.
 *
 * 1080×1920 → 9:16 → 18:32. Any window that is a whole multiple of this has the
 * output's exact ratio and even dimensions.
 */
function evenRatioStep(output: Dimensions): Dimensions {
  const divisor = gcd(output.width, output.height);
  const width = output.width / divisor;
  const height = output.height / divisor;

  return width % 2 === 0 && height % 2 === 0
    ? { width, height }
    : { width: width * 2, height: height * 2 };
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Largest even integer ≤ `value`. Never negative for a non-negative input. */
const evenFloor = (value: number): number => Math.max(0, Math.floor(value / 2) * 2);

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/** True when the plan is internally consistent enough to hand to the renderer. */
export function isCropPlanValid(plan: CropPlan, clipRange: TimeRange): boolean {
  if (!isValidDimensions(plan.source) || !isValidDimensions(plan.output)) return false;
  if (plan.keyframes.length === 0) return false;
  if (plan.strategy === 'static' && plan.keyframes.length !== 1) return false;

  const clipDuration = clipRange.endSec - clipRange.startSec;
  let previousAt = -Infinity;

  for (const kf of plan.keyframes) {
    if (kf.width <= 0 || kf.height <= 0) return false;
    if (kf.x < 0 || kf.y < 0) return false;
    // A window running off the edge of the source is not something FFmpeg can
    // crop; it would produce a black band or fail outright.
    if (!cropWindowFits(kf, plan.source)) return false;
    if (kf.atSec < 0 || kf.atSec > clipDuration) return false;
    if (kf.atSec <= previousAt) return false;
    previousAt = kf.atSec;
  }

  return true;
}
