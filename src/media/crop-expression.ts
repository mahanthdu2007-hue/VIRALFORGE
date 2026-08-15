/**
 * A moving `CropPlan` → an FFmpeg `crop` filter.
 *
 * A static plan is one rectangle and needs no machinery. A tracked plan is a
 * list of keyframes, and the picture has to travel between them *inside a
 * single FFmpeg invocation* — splitting the clip into one render per keyframe
 * and joining the pieces would re-encode repeatedly, drift the audio, and show
 * a seam at every join.
 *
 * The simplest thing that avoids all of that is already in FFmpeg: `crop`
 * re-evaluates its `x` and `y` expressions **for every frame**, with `t` bound
 * to that frame's timestamp. So the whole path is one filter whose offsets are
 * a piecewise-linear function of `t` — the same function `cropWindowAt` applies
 * in the domain, transcribed into FFmpeg's expression language. No new
 * dependency, no per-frame driving from this process, and the render stays one
 * decode/encode pass.
 *
 * Four properties are load-bearing, and each is a decision rather than an
 * accident:
 *
 *  1. **The window never changes size.** `crop` cannot resize its output
 *     mid-stream, and a window that grew or shrank would have to be re-scaled
 *     by a different factor each frame — a zoom this phase does not do. A plan
 *     whose keyframes disagree on size is rejected, not silently resized.
 *  2. **The ratio is checked, not assumed.** The window is scaled to the output
 *     frame by a single `scale` at the end of the chain; if its ratio differed
 *     from the output's, that scale would stretch faces. It is an error here.
 *  3. **Offsets are clamped into the source.** Positions come out of a smoother
 *     and a velocity limiter, where a pixel of overshoot at an endpoint is
 *     ordinary. Clamping repairs it exactly as the domain does — moving the
 *     window, never resizing it — so a good path is not failed over arithmetic
 *     that has no visible consequence. Sizes and ratios, which cannot be
 *     repaired without changing the picture, still throw.
 *  4. **Ends are held, not extrapolated.** Before the first keyframe and after
 *     the last, the expression is constant. `t` can sit slightly outside the
 *     keyframed span (frame timestamps are not exact multiples of the sample
 *     grid), and a linear extrapolation there would drift the window off the
 *     subject for the sake of arithmetic tidiness.
 *
 * Everything here is pure: strings in, strings out, no I/O, no clock. The exact
 * filter is therefore an assertion in a unit test rather than something you
 * discover from a render that looks wrong.
 */

import {
  clampCropWindow,
  isValidDimensions,
  type CropKeyframe,
  type CropPlan,
  type CropWindow,
  type Dimensions,
} from '@/domain';
import { validationError } from '@/lib/errors';

/** One axis of the path: a value in source pixels at an instant on the clip. */
export interface CropPathPoint {
  /** Seconds on the *clip* timeline — the same timeline FFmpeg's `t` uses. */
  readonly atSec: number;
  readonly value: number;
}

/** A crop plan reduced to what the filter needs: a fixed size and two paths. */
export interface NormalizedCropPath {
  /** Constant for the whole clip; see property 1 above. */
  readonly window: Dimensions;
  readonly x: readonly CropPathPoint[];
  readonly y: readonly CropPathPoint[];
  /** False when every keyframe names the same offset — a still crop. */
  readonly moves: boolean;
}

/** The `crop` filter for one fixed window: width, height, then the corner. */
export const cropFilter = (window: CropWindow): string =>
  `crop=${window.width}:${window.height}:${window.x}:${window.y}`;

/**
 * Reduce a plan to a renderable path.
 *
 * Keyframes are sorted, coincident ones collapsed (the later wins, matching
 * `cropWindowAt`), and offsets clamped into the source frame.
 *
 * @throws AppError kind=validation when the geometry cannot be rendered as one
 *         moving window: no keyframes, an unusable time or size, a size that
 *         varies across the plan or does not fit the source.
 */
export function normalizeCropPath(plan: CropPlan): NormalizedCropPath {
  const source = plan.source;

  if (!isValidDimensions(source)) {
    throw validationError('invalid_source_dimensions', 'The crop plan names an unusable source frame.', {
      details: { source },
    });
  }

  if (plan.keyframes.length === 0) {
    throw validationError('crop_plan_empty', 'The crop plan has no keyframes.');
  }

  const first = plan.keyframes[0]!;
  const window = assertRenderableWindow(first, source, plan.output);

  for (const keyframe of plan.keyframes) {
    if (!Number.isFinite(keyframe.atSec) || keyframe.atSec < 0) {
      throw validationError('crop_keyframe_time_invalid', 'A crop keyframe has an unusable timestamp.', {
        details: { atSec: keyframe.atSec },
      });
    }

    if (keyframe.width !== window.width || keyframe.height !== window.height) {
      // A window that resizes mid-clip is a zoom; `crop` cannot express one and
      // faking it with a per-frame scale would change the ratio frame by frame.
      throw validationError(
        'crop_window_size_varies',
        'The crop window changes size between keyframes; only panning is supported.',
        { details: { expected: window, got: { width: keyframe.width, height: keyframe.height } } },
      );
    }
  }

  const ordered = dedupeByTime([...plan.keyframes].sort((a, b) => a.atSec - b.atSec));

  // Clamping moves the window and never resizes it, so the ratio checked above
  // survives it, and the result is inside the source by construction.
  const windows = ordered.map((keyframe) => ({
    atSec: keyframe.atSec,
    ...clampCropWindow({ ...window, x: keyframe.x, y: keyframe.y }, source),
  }));

  const x = windows.map((w) => ({ atSec: w.atSec, value: w.x }));
  const y = windows.map((w) => ({ atSec: w.atSec, value: w.y }));

  return {
    window,
    x,
    y,
    moves: !(isStill(x) && isStill(y)),
  };
}

/**
 * The `crop` filter that realises a path.
 *
 * A still path — one keyframe, or several that never move — produces exactly
 * the static filter `cropFilter` writes. That is not an optimisation for its
 * own sake: a constant expression would make every frame pay for an evaluation
 * that cannot change, and the simpler command is the one that is easy to read
 * in a log.
 */
export function cropPathFilter(path: NormalizedCropPath): string {
  if (!path.moves) {
    return cropFilter({ ...path.window, x: path.x[0]!.value, y: path.y[0]!.value });
  }

  // Single quotes keep the commas inside the expressions from being read as
  // filter separators by the filtergraph parser. The expressions contain only
  // digits, operators and identifiers, so nothing inside needs escaping.
  return [
    `crop=w=${path.window.width}`,
    `h=${path.window.height}`,
    `x='${cropPathExpression(path.x)}'`,
    `y='${cropPathExpression(path.y)}'`,
  ].join(':');
}

/** Plan → filter, in one step. Static plans give the static filter. */
export const dynamicCropFilter = (plan: CropPlan): string => cropPathFilter(normalizeCropPath(plan));

/**
 * One axis as an FFmpeg expression in `t`.
 *
 * Built from the last segment backwards, so each `if` falls through to the one
 * after it: `if(t < t₁, segment₀, if(t < t₂, segment₁, … , vₙ))`. The final
 * `else` is the last value — the held tail. A held head is prepended only when
 * the first keyframe is not at zero, since `t < 0` cannot happen otherwise.
 */
export function cropPathExpression(points: readonly CropPathPoint[]): string {
  const last = points[points.length - 1];
  if (!last) throw validationError('crop_path_empty', 'The crop path has no points.');
  if (isStill(points)) return num(points[0]!.value);

  let expression = num(last.value);

  for (let i = points.length - 2; i >= 0; i -= 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    expression = `if(lt(t,${num(to.atSec)}),${segment(from, to)},${expression})`;
  }

  const start = points[0]!;
  return start.atSec > 0
    ? `if(lt(t,${num(start.atSec)}),${num(start.value)},${expression})`
    : expression;
}

/* -------------------------------------------------------------------------- */

/** `v₀ + slope·(t − t₀)` for one span, written as compactly as it reads. */
function segment(from: CropPathPoint, to: CropPathPoint): string {
  const span = to.atSec - from.atSec;
  // Coincident points are collapsed upstream; a zero span here would divide by
  // zero, so it degrades to a hold rather than producing `inf`.
  const slope = span > 0 ? (to.value - from.value) / span : 0;
  const rounded = round(slope);
  if (rounded === 0) return num(from.value);

  const elapsed = from.atSec > 0 ? `(t-${num(from.atSec)})` : 't';
  // `100+-4*t` is legal but unreadable, and a sign is one character either way.
  const sign = rounded < 0 ? '-' : '+';

  return `${num(from.value)}${sign}${num(Math.abs(rounded))}*${elapsed}`;
}

/**
 * The size and ratio the whole path must have.
 *
 * @throws AppError kind=validation for a size that is not usable, does not fit
 *         the source, or does not share the output's aspect ratio.
 */
function assertRenderableWindow(
  keyframe: CropKeyframe,
  source: Dimensions,
  output: Dimensions,
): Dimensions {
  const window = { width: keyframe.width, height: keyframe.height };

  if (!isValidDimensions(window)) {
    throw validationError('crop_window_invalid_size', 'The crop window has an unusable size.', {
      details: { window },
    });
  }

  if (window.width > source.width || window.height > source.height) {
    throw validationError('crop_window_out_of_bounds', 'The crop window is larger than the source frame.', {
      details: { window, source },
    });
  }

  // Cross-multiplied rather than divided: the window is scaled to the output by
  // a single factor, and only an exact ratio match makes that factor the same
  // in both axes. "Close enough" here is a stretched face.
  if (isValidDimensions(output) && window.width * output.height !== window.height * output.width) {
    throw validationError(
      'crop_window_aspect_mismatch',
      'The crop window does not share the output frame’s aspect ratio; scaling it would stretch the picture.',
      { details: { window, output } },
    );
  }

  return window;
}

/** Keep one keyframe per instant; the later one wins, as `cropWindowAt` does. */
function dedupeByTime(sorted: readonly CropKeyframe[]): CropKeyframe[] {
  const kept: CropKeyframe[] = [];

  for (const keyframe of sorted) {
    if (kept.length > 0 && kept[kept.length - 1]!.atSec === keyframe.atSec) kept.pop();
    kept.push(keyframe);
  }

  return kept;
}

const isStill = (points: readonly CropPathPoint[]): boolean =>
  points.every((point) => point.value === points[0]!.value);

/** Six decimals is finer than a pixel at any frame rate, and never exponential. */
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

const num = (value: number): string => String(round(value));
