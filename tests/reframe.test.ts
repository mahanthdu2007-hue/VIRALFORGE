import { describe, expect, it } from 'vitest';
import {
  aspectRatio,
  cropWindowFits,
  isCropPlanValid,
  planCenterCrop,
  SHORTS_ASPECT_RATIO,
  SHORTS_OUTPUT,
  type CropPlan,
  type Dimensions,
} from '@/domain';
import {
  centerCropPlan,
  centerCropProfile,
  cropFilter,
  outputAspectRatio,
  withCropPlan,
} from '@/media/reframe';
import {
  buildCutArgs,
  decideRenderMode,
  videoFilterChain,
  DEFAULT_RENDER_PROFILE,
} from '@/media/clip-render';
import { isAppError } from '@/lib/errors';

const window = (source: Dimensions) => centerCropPlan(source).keyframes[0]!;

const joined = (args: readonly string[]) => args.join(' ');

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

describe('planCenterCrop — 16:9 source', () => {
  const source = { width: 1920, height: 1080 };

  it('crops the sides and keeps the full usable height', () => {
    expect(window(source)).toEqual({ atSec: 0, x: 662, y: 12, width: 594, height: 1056 });
  });

  it('centres the window horizontally, to the nearest even pixel', () => {
    const kf = window(source);
    const leftMargin = kf.x;
    const rightMargin = source.width - (kf.x + kf.width);
    // Even offsets mean the two margins can differ by at most one pixel.
    expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(2);
  });

  it('is deterministic', () => {
    expect(centerCropPlan(source)).toEqual(centerCropPlan(source));
  });

  it('records the source it was computed against without altering it', () => {
    const plan = centerCropPlan(source);
    expect(plan.source).toEqual(source);
    expect(plan.strategy).toBe('static');
    expect(plan.keyframes).toHaveLength(1);
  });
});

describe('planCenterCrop — 4:3 source', () => {
  const source = { width: 640, height: 480 };

  it('crops the sides, since 4:3 is still wider than 9:16', () => {
    expect(window(source)).toEqual({ atSec: 0, x: 184, y: 0, width: 270, height: 480 });
  });

  it('takes the whole height when the ratio divides exactly', () => {
    expect(window(source).height).toBe(source.height);
  });
});

describe('planCenterCrop — already 9:16', () => {
  it('takes the whole frame at the output resolution', () => {
    expect(window({ width: 1080, height: 1920 })).toEqual({
      atSec: 0,
      x: 0,
      y: 0,
      width: 1080,
      height: 1920,
    });
  });

  it('crops the top and bottom of a source taller than 9:16', () => {
    // 1080×2400 is narrower than 9:16, so height is the axis that gives.
    const kf = window({ width: 1080, height: 2400 });
    expect(kf.width).toBe(1080);
    expect(kf.height).toBe(1920);
    expect(kf.y).toBe(240);
  });
});

describe('planCenterCrop — odd dimensions', () => {
  it.each([
    [{ width: 1921, height: 1081 }],
    [{ width: 641, height: 481 }],
    [{ width: 1081, height: 1921 }],
    [{ width: 999, height: 777 }],
  ])('produces even sizes and offsets for %o', (source) => {
    const kf = window(source);

    for (const value of [kf.x, kf.y, kf.width, kf.height]) {
      // yuv420p subsamples chroma 2×2: odd numbers have no defined chroma plane.
      expect(value % 2).toBe(0);
    }
  });

  it('never rounds a window past the edge of an odd frame', () => {
    const source = { width: 1921, height: 1081 };
    expect(cropWindowFits(window(source), source)).toBe(true);
  });
});

describe('planCenterCrop — invalid dimensions', () => {
  it.each([
    [{ width: 0, height: 1080 }],
    [{ width: 1920, height: 0 }],
    [{ width: -1920, height: 1080 }],
    [{ width: 1920.5, height: 1080 }],
    [{ width: Number.NaN, height: 1080 }],
    [{ width: Number.POSITIVE_INFINITY, height: 1080 }],
  ])('rejects source %o', (source) => {
    expect(planCenterCrop({ source })).toEqual({ ok: false, reason: 'invalid_source_dimensions' });
  });

  it('rejects an unusable output size', () => {
    expect(planCenterCrop({ source: { width: 1920, height: 1080 }, output: { width: 0, height: 1920 } })).toEqual({
      ok: false,
      reason: 'invalid_output_dimensions',
    });
  });

  it('rejects a source too small to hold any window of the ratio', () => {
    expect(planCenterCrop({ source: { width: 10, height: 10 } })).toEqual({
      ok: false,
      reason: 'source_too_small',
    });
  });

  it('reports failure as a validation error at the media seam', () => {
    try {
      centerCropPlan({ width: 0, height: 0 });
      expect.unreachable('centerCropPlan should have thrown');
    } catch (error) {
      expect(isAppError(error) && error.kind).toBe('validation');
      expect(isAppError(error) && error.code).toBe('invalid_source_dimensions');
    }
  });
});

describe('crop bounds', () => {
  const sources: Dimensions[] = [
    { width: 1920, height: 1080 },
    { width: 3840, height: 2160 },
    { width: 640, height: 480 },
    { width: 1080, height: 1920 },
    { width: 320, height: 240 },
    { width: 1921, height: 1081 },
    { width: 18, height: 32 },
  ];

  it.each(sources)('stays inside the source frame for %o', (source) => {
    const kf = window(source);

    expect(kf.x).toBeGreaterThanOrEqual(0);
    expect(kf.y).toBeGreaterThanOrEqual(0);
    expect(kf.x + kf.width).toBeLessThanOrEqual(source.width);
    expect(kf.y + kf.height).toBeLessThanOrEqual(source.height);
  });

  it.each(sources)('is the largest window of the ratio that fits %o', (source) => {
    const kf = window(source);
    // One step larger (18×32 more) would not fit in at least one axis.
    expect(kf.width + 18 > source.width || kf.height + 32 > source.height).toBe(true);
  });

  it('passes the domain plan validator', () => {
    expect(isCropPlanValid(centerCropPlan({ width: 1920, height: 1080 }), { startSec: 0, endSec: 30 })).toBe(true);
  });
});

describe('output aspect ratio', () => {
  it.each([
    [{ width: 1920, height: 1080 }],
    [{ width: 640, height: 480 }],
    [{ width: 1080, height: 1920 }],
    [{ width: 1921, height: 1081 }],
    [{ width: 320, height: 240 }],
  ])('gives the window the exact 9:16 ratio for %o', (source) => {
    const kf = window(source);
    // Exact, not approximate: the scale step must be uniform in both axes or
    // the picture is stretched.
    expect(kf.width * 16).toBe(kf.height * 9);
    expect(aspectRatio(kf)).toBe(SHORTS_ASPECT_RATIO);
  });

  it('targets a 1080×1920 output by default', () => {
    const plan = centerCropPlan({ width: 1920, height: 1080 });
    expect(plan.output).toEqual(SHORTS_OUTPUT);
    expect(outputAspectRatio(plan)).toBe(SHORTS_ASPECT_RATIO);
    expect(plan.targetAspectRatio).toBe(SHORTS_ASPECT_RATIO);
  });

  it('honours a different output frame of the same ratio', () => {
    const plan = centerCropPlan({ width: 1920, height: 1080 }, { width: 720, height: 1280 });
    expect(plan.output).toEqual({ width: 720, height: 1280 });
    expect(outputAspectRatio(plan)).toBe(SHORTS_ASPECT_RATIO);
  });

  it('scales the crop window to the output without distortion', () => {
    const plan = centerCropPlan({ width: 1920, height: 1080 });
    const kf = plan.keyframes[0]!;
    // The same factor in both axes is what "no stretching" means numerically.
    expect(plan.output.width / kf.width).toBeCloseTo(plan.output.height / kf.height, 10);
  });
});

/* -------------------------------------------------------------------------- */
/* FFmpeg filter generation                                                   */
/* -------------------------------------------------------------------------- */

describe('cropFilter', () => {
  it('writes width:height:x:y, in that order', () => {
    expect(cropFilter({ x: 662, y: 12, width: 594, height: 1056 })).toBe('crop=594:1056:662:12');
  });
});

describe('withCropPlan', () => {
  const source = { width: 1920, height: 1080 };

  it('adds a crop filter and a scale to the output frame', () => {
    const { profile } = centerCropProfile({ source });

    expect(profile.videoFilters).toEqual(['crop=594:1056:662:12']);
    expect(profile.scale).toEqual({ width: 1080, height: 1920 });
    expect(videoFilterChain(profile)).toBe('crop=594:1056:662:12,scale=1080:1920');
  });

  it('omits the scale when the window is already the output size', () => {
    const { profile } = centerCropProfile({ source: { width: 1080, height: 1920 } });

    expect(profile.scale).toBeNull();
    expect(videoFilterChain(profile)).toBe('crop=1080:1920:0:0');
  });

  it('appends to existing filters rather than replacing them', () => {
    const { plan } = centerCropProfile({ source });
    const profile = withCropPlan({ ...DEFAULT_RENDER_PROFILE, videoFilters: ['fps=30'] }, plan);

    expect(profile.videoFilters).toEqual(['fps=30', 'crop=594:1056:662:12']);
  });

  it('leaves the audio settings of the base profile untouched', () => {
    const { profile } = centerCropProfile({ source });

    expect(profile.audioCodec).toBe(DEFAULT_RENDER_PROFILE.audioCodec);
    expect(profile.audioBitrate).toBe(DEFAULT_RENDER_PROFILE.audioBitrate);
    expect(profile.audioSampleRateHz).toBeNull();
  });

  it('renders a tracked plan that never moves as the same static filter', () => {
    const plan: CropPlan = { ...centerCropPlan(source), strategy: 'tracked' };

    expect(withCropPlan(DEFAULT_RENDER_PROFILE, plan).videoFilters).toEqual(['crop=594:1056:662:12']);
  });

  it('refuses a strategy the renderer has no filter for', () => {
    const plan: CropPlan = { ...centerCropPlan(source), strategy: 'letterbox' };

    expect(() => withCropPlan(DEFAULT_RENDER_PROFILE, plan)).toThrowError(/letterbox/i);
  });

  it('refuses a window that falls outside the frame it names', () => {
    const base = centerCropPlan(source);
    const plan: CropPlan = { ...base, keyframes: [{ atSec: 0, x: 1800, y: 0, width: 594, height: 1056 }] };

    try {
      withCropPlan(DEFAULT_RENDER_PROFILE, plan);
      expect.unreachable('withCropPlan should have thrown');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('crop_window_out_of_bounds');
    }
  });
});

describe('crop integration with the render command builder', () => {
  const source = { width: 1920, height: 1080 };
  const cut = { startSec: 10, endSec: 40 };

  it('forces the re-encode path, even on a keyframe-aligned cut', () => {
    const { profile } = centerCropProfile({ source });

    expect(
      decideRenderMode({
        cuts: [cut],
        profile,
        videoCodec: 'h264',
        audioCodec: 'aac',
        keyframeTimesPerCut: [[10]],
      }),
    ).toEqual({ mode: 'reencode', reason: 'filters_requested' });
  });

  it('puts the crop and scale on the command line as one filter chain', () => {
    const { profile } = centerCropProfile({ source });
    const args = joined(buildCutArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', cut, mode: 'reencode', profile }));

    expect(args).toContain('-vf crop=594:1056:662:12,scale=1080:1920');
  });

  it('still maps and re-encodes the original audio alongside the cropped video', () => {
    const { profile } = centerCropProfile({ source });
    const args = joined(buildCutArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', cut, mode: 'reencode', profile }));

    expect(args).toContain('-map 0:a:0?');
    expect(args).toContain('-c:a aac');
    expect(args).toContain('-b:a 192k');
    // No audio filter, no resampling: the speech is bit-for-bit the same take.
    expect(args).not.toContain('-af');
    expect(args).not.toContain('-ar ');
  });

  it('keeps the timestamp flags that hold audio and video in sync', () => {
    const { profile } = centerCropProfile({ source });
    const args = joined(buildCutArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', cut, mode: 'reencode', profile }));

    expect(args).toContain('-avoid_negative_ts make_zero');
    expect(args).toContain('-muxpreload 0');
    expect(args).toContain('-muxdelay 0');
  });

  it('names the source only as an input — cropping never writes to it', () => {
    const { profile } = centerCropProfile({ source });
    const args = buildCutArgs({
      sourcePath: '/videos/source.mp4',
      outputPath: '/renders/clip.mp4',
      cut,
      mode: 'reencode',
      profile,
    });

    expect(args.filter((a) => a === '/videos/source.mp4')).toHaveLength(1);
    expect(args.at(-1)).toBe('/renders/clip.mp4');
  });
});
