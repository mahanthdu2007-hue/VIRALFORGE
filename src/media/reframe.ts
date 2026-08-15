/**
 * 9:16 reframing, expressed as a `RenderProfile`.
 *
 * This is the whole integration surface for reframing: the geometry is computed
 * in the domain (`planCenterCrop`, pure integer arithmetic), and this module
 * turns a `CropPlan` into the two FFmpeg filters that realise it — `crop` to
 * take the window out of the source, `scale` to bring that window up to the
 * output frame. Neither `buildCutArgs` nor `FfmpegClipRenderer` needs to know
 * reframing exists; they already apply whatever filters a profile carries.
 *
 * Three consequences follow from doing it this way, and they are the reason for
 * the seam rather than a special-cased renderer:
 *
 *  1. **Re-encoding is automatic.** `decideRenderMode` re-encodes whenever a
 *     profile filters anything, because filtering copied packets is impossible.
 *     A cropped render therefore never takes the stream-copy path — nothing
 *     here has to ask for that.
 *  2. **Audio is untouched.** No filter added here is an audio filter, and the
 *     profile's audio settings are carried through unchanged. The speech in the
 *     output is the speech in the source, at the same rate, so it stays in sync
 *     with a video track whose frame timings were never altered either.
 *  3. **The source is read-only.** A `CropPlan` describes a window; producing
 *     it writes a new file and cannot modify the input.
 */

import {
  aspectRatio,
  cropWindowFits,
  planCenterCrop,
  SHORTS_OUTPUT,
  type CropPlan,
  type Dimensions,
} from '@/domain';
import { validationError } from '@/lib/errors';
import { DEFAULT_RENDER_PROFILE, type RenderProfile } from './clip-render';
import { cropFilter, cropPathFilter, normalizeCropPath } from './crop-expression';

/**
 * Filter construction lives in `crop-expression`, which handles the static
 * window and the moving path in one place; it is re-exported here because this
 * module is the reframing seam callers import.
 */
export { cropFilter, cropPathFilter, dynamicCropFilter, normalizeCropPath } from './crop-expression';

/**
 * Centre-crop plan for a source of the given size.
 *
 * @throws AppError kind=validation when the source dimensions are unusable or
 *         too small to hold a window of the target ratio.
 */
export function centerCropPlan(source: Dimensions, output: Dimensions = SHORTS_OUTPUT): CropPlan {
  const result = planCenterCrop({ source, output });

  if (!result.ok) {
    throw validationError(result.reason, cropFailureMessage(result.reason), {
      details: { source, output },
    });
  }

  return result.plan;
}

/**
 * Add a crop plan's filters to a profile.
 *
 * The scale is omitted when the window is already the output size — a source
 * that is natively 9:16 at the output resolution is cropped to itself and
 * resampled for nothing otherwise.
 *
 * @throws AppError kind=validation for a plan the renderer cannot execute:
 *         an unsupported strategy, or a window that does not lie inside the
 *         frame it names.
 */
export function withCropPlan(profile: RenderProfile, plan: CropPlan): RenderProfile {
  if (plan.strategy === 'tracked') return withTrackedCropPlan(profile, plan);

  if (plan.strategy !== 'static') {
    throw validationError(
      'crop_strategy_unsupported',
      `Only static and tracked crops can be rendered; got "${plan.strategy}".`,
      { details: { strategy: plan.strategy } },
    );
  }

  const window = plan.keyframes[0];
  if (!window) {
    throw validationError('crop_plan_empty', 'The crop plan has no keyframes.');
  }

  if (!cropWindowFits(window, plan.source)) {
    throw validationError('crop_window_out_of_bounds', 'The crop window falls outside the source frame.', {
      details: { window, source: plan.source },
    });
  }

  const needsScale = window.width !== plan.output.width || window.height !== plan.output.height;

  return {
    ...profile,
    // Appended, not replaced: a later phase's subtitle filter burns onto the
    // reframed picture, so it must be able to sit after this one.
    videoFilters: [...profile.videoFilters, cropFilter(window)],
    // `scale` is applied last by `videoFilterChain`, which is the right order:
    // crop in source pixels, then resample the result to the output frame.
    // Both rectangles have the same ratio by construction, so this is a uniform
    // resize — it never stretches.
    scale: needsScale ? { width: plan.output.width, height: plan.output.height } : null,
  };
}

/**
 * The tracked half of `withCropPlan`.
 *
 * Structurally identical to the static half — one crop filter appended, one
 * scale to the output frame — which is the point: a moving crop is not a
 * different render, only a different `crop`. The window's size is constant
 * across the path (`normalizeCropPath` insists on it), so the single trailing
 * `scale` is as uniform here as it is for a static window, and the whole clip
 * is still one decode/encode pass with its audio untouched.
 *
 * One constraint the pipeline will have to respect when it wires this up: the
 * keyframes are timed against `t`, which restarts at zero for each FFmpeg
 * invocation. A multi-cut plan renders one invocation per cut, so a path
 * spanning such a plan would replay from its start in every segment. Every plan
 * built today has a single cut; a tracked multi-cut plan needs the path split
 * per cut before it reaches here.
 */
function withTrackedCropPlan(profile: RenderProfile, plan: CropPlan): RenderProfile {
  const path = normalizeCropPath(plan);
  const needsScale =
    path.window.width !== plan.output.width || path.window.height !== plan.output.height;

  return {
    ...profile,
    videoFilters: [...profile.videoFilters, cropPathFilter(path)],
    scale: needsScale ? { width: plan.output.width, height: plan.output.height } : null,
  };
}

export interface CenterCropProfileInput {
  readonly source: Dimensions;
  readonly output?: Dimensions;
  /** Base encoder settings. Defaults to the standard render profile. */
  readonly profile?: RenderProfile;
}

/** Plan a centre crop and fold it into a profile in one step. */
export function centerCropProfile(input: CenterCropProfileInput): {
  readonly plan: CropPlan;
  readonly profile: RenderProfile;
} {
  const plan = centerCropPlan(input.source, input.output ?? SHORTS_OUTPUT);
  return { plan, profile: withCropPlan(input.profile ?? DEFAULT_RENDER_PROFILE, plan) };
}

/** The ratio a plan's output actually has. Asserted in tests, not assumed. */
export const outputAspectRatio = (plan: CropPlan): number => aspectRatio(plan.output);

const cropFailureMessage = (reason: string): string =>
  reason === 'source_too_small'
    ? 'The source is too small to crop to the target aspect ratio.'
    : 'The crop dimensions are not usable.';
