/**
 * The moving crop, as a command line.
 *
 * `tests/tracking.test.ts` proves the path is smooth; this proves the path
 * survives the trip into FFmpeg's expression language — that the expression is
 * the same piecewise-linear function `cropWindowAt` evaluates, that the window
 * stays inside the source and stays 9:16, and that a filtered render still
 * takes the re-encode path with its audio untouched.
 */

import { describe, expect, it } from 'vitest';
import {
  cropWindowAt,
  cropWindowFits,
  largestCenteredWindow,
  SHORTS_ASPECT_RATIO,
  SHORTS_OUTPUT,
  type CropKeyframe,
  type CropPlan,
  type Dimensions,
} from '@/domain';
import {
  cropPathExpression,
  cropPathFilter,
  dynamicCropFilter,
  normalizeCropPath,
} from '@/media/crop-expression';
import { withCropPlan } from '@/media/reframe';
import { buildCutArgs, decideRenderMode, videoFilterChain, DEFAULT_RENDER_PROFILE } from '@/media/clip-render';
import { buildCropPath } from '@/tracking';
import { isAppError } from '@/lib/errors';

const SOURCE: Dimensions = { width: 1920, height: 1080 };
/** 594×1056 — the centre-crop window for a 1920×1080 source. */
const WINDOW = largestCenteredWindow(SOURCE, SHORTS_OUTPUT)!;

const keyframe = (atSec: number, x: number, y = 12): CropKeyframe => ({
  atSec,
  x,
  y,
  width: WINDOW.width,
  height: WINDOW.height,
});

const trackedPlan = (keyframes: readonly CropKeyframe[], overrides: Partial<CropPlan> = {}): CropPlan => ({
  strategy: 'tracked',
  source: SOURCE,
  output: SHORTS_OUTPUT,
  targetAspectRatio: SHORTS_ASPECT_RATIO,
  keyframes,
  rationale: null,
  ...overrides,
});

/**
 * Evaluate an FFmpeg crop expression the way FFmpeg does.
 *
 * Only the three constructs the builder emits are supported — `if`, `lt` and
 * arithmetic — which is exactly the point: if the builder ever emits something
 * else, this stops being able to read it.
 */
function evaluate(expression: string, t: number): number {
  const source = expression
    .replace(/\bif\(/g, '__if(')
    .replace(/\blt\(/g, '__lt(')
    .replace(/\bt\b/g, '__t');

  const fn = new Function(
    '__t',
    '__if',
    '__lt',
    `"use strict"; return (${source});`,
  ) as (t: number, iff: (c: number, a: number, b: number) => number, lt: (a: number, b: number) => number) => number;

  return fn(t, (condition, then, otherwise) => (condition !== 0 ? then : otherwise), (a, b) => (a < b ? 1 : 0));
}

const sampled = (expression: string, times: readonly number[]) =>
  times.map((t) => evaluate(expression, t));

/* -------------------------------------------------------------------------- */
/* Expression generation                                                      */
/* -------------------------------------------------------------------------- */

describe('cropPathExpression', () => {
  it('collapses a path that never moves to a constant', () => {
    expect(cropPathExpression([{ atSec: 0, value: 300 }, { atSec: 10, value: 300 }])).toBe('300');
  });

  it('writes two keyframes as one linear ramp with a held tail', () => {
    const expression = cropPathExpression([{ atSec: 0, value: 100 }, { atSec: 4, value: 300 }]);

    expect(expression).toBe('if(lt(t,4),100+50*t,300)');
  });

  it('subtracts rather than adding a negative slope', () => {
    const expression = cropPathExpression([{ atSec: 0, value: 300 }, { atSec: 4, value: 100 }]);

    expect(expression).toBe('if(lt(t,4),300-50*t,100)');
  });

  it('offsets `t` for a segment that does not start at zero', () => {
    const expression = cropPathExpression([
      { atSec: 0, value: 0 },
      { atSec: 2, value: 0 },
      { atSec: 4, value: 100 },
    ]);

    expect(expression).toContain('0+50*(t-2)');
  });

  it('holds the head when the first keyframe is not at zero', () => {
    const expression = cropPathExpression([{ atSec: 2, value: 100 }, { atSec: 4, value: 300 }]);

    expect(expression.startsWith('if(lt(t,2),100,')).toBe(true);
    expect(evaluate(expression, 0)).toBe(100);
    expect(evaluate(expression, 1.9)).toBe(100);
  });

  it('interpolates linearly between keyframes', () => {
    const expression = cropPathExpression([{ atSec: 0, value: 100 }, { atSec: 4, value: 300 }]);

    expect(sampled(expression, [0, 1, 2, 3, 4])).toEqual([100, 150, 200, 250, 300]);
  });

  it('holds both ends rather than extrapolating past them', () => {
    const expression = cropPathExpression([{ atSec: 1, value: 100 }, { atSec: 3, value: 200 }]);

    // A frame timestamp can sit either side of the keyframed span; neither end
    // may keep travelling.
    expect(sampled(expression, [-1, 0, 0.999])).toEqual([100, 100, 100]);
    expect(sampled(expression, [3, 4, 1000])).toEqual([200, 200, 200]);
  });

  it('agrees with cropWindowAt across a many-keyframe path', () => {
    const keyframes = [
      keyframe(0, 0),
      keyframe(1.5, 200),
      keyframe(3, 180),
      keyframe(4.25, 900),
      keyframe(8, 1326),
      keyframe(12, 400),
    ];
    const path = normalizeCropPath(trackedPlan(keyframes));
    const expression = cropPathExpression(path.x);

    for (let t = 0; t <= 13; t += 0.25) {
      // The domain floors to an even pixel and FFmpeg's crop does its own chroma
      // alignment, so the two agree to within that step rather than exactly.
      expect(Math.abs(evaluate(expression, t) - cropWindowAt(trackedPlan(keyframes), t).x)).toBeLessThanOrEqual(2);
    }
  });

  it('never jumps: the value moves continuously across every keyframe', () => {
    const path = normalizeCropPath(
      trackedPlan([keyframe(0, 0), keyframe(2, 600), keyframe(2.5, 100), keyframe(9, 1326)]),
    );
    const expression = cropPathExpression(path.x);

    let previous = evaluate(expression, 0);
    for (let t = 0.02; t <= 10; t += 0.02) {
      const current = evaluate(expression, t);
      // The steepest segment is 1000px/s (600→100 in 0.5s); one 20ms step of it
      // is 20px. Anything larger would be a cut, not a pan.
      expect(Math.abs(current - previous)).toBeLessThanOrEqual(21);
      previous = current;
    }
  });

  it('stays inside the source across the whole path', () => {
    const path = normalizeCropPath(
      trackedPlan([keyframe(0, 0), keyframe(3, 1326), keyframe(6, 0), keyframe(9, 1326)]),
    );
    const x = cropPathExpression(path.x);
    const y = cropPathExpression(path.y);

    for (let t = 0; t <= 10; t += 0.1) {
      const window = { x: evaluate(x, t), y: evaluate(y, t), ...path.window };
      expect(cropWindowFits(window, SOURCE)).toBe(true);
    }
  });

  it('emits plain decimals, never exponent notation', () => {
    const expression = cropPathExpression([
      { atSec: 0, value: 0 },
      { atSec: 1_000_000, value: 1 },
    ]);

    // `String(1e-6)` is fine but `String(1e-7)` is "1e-7", which FFmpeg reads as
    // 1. Anything finer than a millionth is rounded away instead.
    expect(expression).not.toMatch(/e[+-]/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Filter generation                                                          */
/* -------------------------------------------------------------------------- */

describe('cropPathFilter', () => {
  it('writes a moving path as a crop with quoted x and y expressions', () => {
    const filter = dynamicCropFilter(trackedPlan([keyframe(0, 100), keyframe(4, 300)]));

    expect(filter).toBe("crop=w=594:h=1056:x='if(lt(t,4),100+50*t,300)':y='12'");
  });

  it('quotes the expressions so their commas are not read as filter separators', () => {
    const filter = dynamicCropFilter(trackedPlan([keyframe(0, 100), keyframe(4, 300)]));
    const quoted = filter.match(/'[^']*'/g) ?? [];

    // Every comma in the filter must be inside a quoted expression.
    expect(quoted.join('').split(',').length).toBe(filter.split(',').length);
  });

  it('writes a still path as the plain static filter', () => {
    expect(dynamicCropFilter(trackedPlan([keyframe(0, 662), keyframe(5, 662)]))).toBe('crop=594:1056:662:12');
  });

  it('writes a single keyframe as the plain static filter', () => {
    expect(dynamicCropFilter(trackedPlan([keyframe(0, 662)]))).toBe('crop=594:1056:662:12');
  });

  it('is deterministic', () => {
    const plan = trackedPlan([keyframe(0, 0), keyframe(3, 600), keyframe(7, 200)]);

    expect(dynamicCropFilter(plan)).toBe(dynamicCropFilter(plan));
  });

  it('keeps the window size out of the expressions — the crop never resizes', () => {
    const filter = dynamicCropFilter(trackedPlan([keyframe(0, 0), keyframe(4, 1326)]));

    expect(filter).toContain('w=594:h=1056');
  });
});

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

describe('normalizeCropPath', () => {
  it('sorts keyframes by time', () => {
    const path = normalizeCropPath(trackedPlan([keyframe(4, 300), keyframe(0, 100), keyframe(2, 200)]));

    expect(path.x).toEqual([
      { atSec: 0, value: 100 },
      { atSec: 2, value: 200 },
      { atSec: 4, value: 300 },
    ]);
  });

  it('collapses coincident keyframes, keeping the later one', () => {
    const path = normalizeCropPath(trackedPlan([keyframe(0, 100), keyframe(2, 200), keyframe(2, 400)]));

    expect(path.x).toEqual([
      { atSec: 0, value: 100 },
      { atSec: 2, value: 400 },
    ]);
  });

  it('clamps an offset that overshoots the source rather than failing the render', () => {
    const path = normalizeCropPath(trackedPlan([keyframe(0, -40, -10), keyframe(4, 5000, 4000)]));

    expect(path.x).toEqual([
      { atSec: 0, value: 0 },
      { atSec: 4, value: SOURCE.width - WINDOW.width },
    ]);
    expect(path.y).toEqual([
      { atSec: 0, value: 0 },
      { atSec: 4, value: SOURCE.height - WINDOW.height },
    ]);
  });

  it('reports a still path as still', () => {
    expect(normalizeCropPath(trackedPlan([keyframe(0, 662), keyframe(9, 662)])).moves).toBe(false);
    expect(normalizeCropPath(trackedPlan([keyframe(0, 662), keyframe(9, 664)])).moves).toBe(true);
  });

  it('sees vertical-only movement', () => {
    const path = normalizeCropPath(trackedPlan([keyframe(0, 662, 0), keyframe(9, 662, 24)]));

    expect(path.moves).toBe(true);
  });

  it('rejects a plan with no keyframes', () => {
    expect(() => normalizeCropPath(trackedPlan([]))).toThrowError(/no keyframes/i);
  });

  it.each([
    ['a window that changes size', [keyframe(0, 0), { ...keyframe(4, 0), width: 600 }], 'crop_window_size_varies'],
    ['a window larger than the source', [{ ...keyframe(0, 0), width: 4000, height: 7111 }], 'crop_window_out_of_bounds'],
    ['a window of no size', [{ ...keyframe(0, 0), width: 0, height: 0 }], 'crop_window_invalid_size'],
    ['a fractional window', [{ ...keyframe(0, 0), width: 594.5, height: 1056 }], 'crop_window_invalid_size'],
    ['a negative timestamp', [keyframe(-1, 0), keyframe(4, 100)], 'crop_keyframe_time_invalid'],
    ['a non-finite timestamp', [keyframe(Number.NaN, 0), keyframe(4, 100)], 'crop_keyframe_time_invalid'],
  ])('rejects %s', (_label, keyframes, code) => {
    try {
      normalizeCropPath(trackedPlan(keyframes as CropKeyframe[]));
      expect.unreachable('normalizeCropPath should have thrown');
    } catch (error) {
      expect(isAppError(error) && error.kind).toBe('validation');
      expect(isAppError(error) && error.code).toBe(code);
    }
  });

  it('rejects a window whose ratio does not match the output: scaling it would stretch', () => {
    // 16:9 window, 9:16 output — the scale would squash the picture sideways.
    const keyframes = [
      { atSec: 0, x: 0, y: 0, width: 960, height: 540 },
      { atSec: 4, x: 400, y: 0, width: 960, height: 540 },
    ];

    try {
      normalizeCropPath(trackedPlan(keyframes));
      expect.unreachable('normalizeCropPath should have thrown');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('crop_window_aspect_mismatch');
    }
  });

  it('accepts a zero-length clip: every keyframe at the same instant', () => {
    const path = normalizeCropPath(trackedPlan([keyframe(0, 100), keyframe(0, 300)]));

    expect(path.moves).toBe(false);
    expect(cropPathFilter(path)).toBe('crop=594:1056:300:12');
  });

  it('handles a very short clip without dividing by zero', () => {
    const filter = dynamicCropFilter(trackedPlan([keyframe(0, 0), keyframe(0.04, 100)]));

    expect(filter).toContain('2500');
    expect(filter).not.toContain('Infinity');
    expect(filter).not.toContain('NaN');
  });
});

/* -------------------------------------------------------------------------- */
/* Profile and command integration                                            */
/* -------------------------------------------------------------------------- */

describe('withCropPlan — tracked', () => {
  const plan = trackedPlan([keyframe(0, 0), keyframe(4, 662), keyframe(9, 1326)]);

  it('appends the moving crop and scales to the output frame', () => {
    const profile = withCropPlan(DEFAULT_RENDER_PROFILE, plan);

    expect(profile.videoFilters).toHaveLength(1);
    expect(profile.videoFilters[0]).toContain('crop=w=594:h=1056');
    expect(profile.scale).toEqual({ width: 1080, height: 1920 });
    expect(videoFilterChain(profile)!.endsWith(',scale=1080:1920')).toBe(true);
  });

  it('appends to existing filters rather than replacing them', () => {
    const profile = withCropPlan({ ...DEFAULT_RENDER_PROFILE, videoFilters: ['fps=30'] }, plan);

    expect(profile.videoFilters[0]).toBe('fps=30');
    expect(profile.videoFilters).toHaveLength(2);
  });

  it('omits the scale when the moving window is already the output size', () => {
    const source = { width: 2160, height: 1920 };
    const moving = trackedPlan(
      [
        { atSec: 0, x: 0, y: 0, width: 1080, height: 1920 },
        { atSec: 4, x: 1080, y: 0, width: 1080, height: 1920 },
      ],
      { source },
    );

    expect(withCropPlan(DEFAULT_RENDER_PROFILE, moving).scale).toBeNull();
  });

  it('leaves the audio settings untouched', () => {
    const profile = withCropPlan(DEFAULT_RENDER_PROFILE, plan);

    expect(profile.audioCodec).toBe(DEFAULT_RENDER_PROFILE.audioCodec);
    expect(profile.audioBitrate).toBe(DEFAULT_RENDER_PROFILE.audioBitrate);
    expect(profile.audioSampleRateHz).toBeNull();
  });

  it('forces the re-encode path, even on a keyframe-aligned cut', () => {
    const profile = withCropPlan(DEFAULT_RENDER_PROFILE, plan);

    expect(
      decideRenderMode({
        cuts: [{ startSec: 10, endSec: 40 }],
        profile,
        videoCodec: 'h264',
        audioCodec: 'aac',
        keyframeTimesPerCut: [[10]],
      }),
    ).toEqual({ mode: 'reencode', reason: 'filters_requested' });
  });

  it('puts the whole chain on the command line as one -vf argument', () => {
    const profile = withCropPlan(DEFAULT_RENDER_PROFILE, plan);
    const args = buildCutArgs({
      sourcePath: '/videos/source.mp4',
      outputPath: '/renders/clip.mp4',
      cut: { startSec: 10, endSec: 40 },
      mode: 'reencode',
      profile,
    });

    const filterIndex = args.indexOf('-vf');
    expect(filterIndex).toBeGreaterThan(-1);
    expect(args[filterIndex + 1]).toBe(videoFilterChain(profile));
    // One argument, however many commas the expressions contain.
    expect(args.filter((a) => a === '-vf')).toHaveLength(1);
    // The source is an input and nothing else.
    expect(args.filter((a) => a === '/videos/source.mp4')).toHaveLength(1);
    expect(args.at(-1)).toBe('/renders/clip.mp4');
  });

  it('keeps the audio mapping and the sync flags', () => {
    const profile = withCropPlan(DEFAULT_RENDER_PROFILE, plan);
    const args = buildCutArgs({
      sourcePath: 'in.mp4',
      outputPath: 'out.mp4',
      cut: { startSec: 10, endSec: 40 },
      mode: 'reencode',
      profile,
    }).join(' ');

    expect(args).toContain('-map 0:a:0?');
    expect(args).toContain('-c:a aac');
    expect(args).toContain('-avoid_negative_ts make_zero');
    expect(args).not.toContain('-af');
  });
});

/* -------------------------------------------------------------------------- */
/* A path from the tracker, end to end                                        */
/* -------------------------------------------------------------------------- */

describe('a real tracked path from buildCropPath', () => {
  const observations = Array.from({ length: 30 }, (_, i) => ({
    atSec: 10 + i,
    x: 200 + i * 45,
    y: 240,
    width: 200,
    height: 600,
    confidence: 0.9,
    subjectId: 'speaker' as string | null,
  }));

  it('renders as a moving crop that stays in bounds for the whole clip', () => {
    const plan = buildCropPath(observations, { source: SOURCE, range: { startSec: 10, endSec: 40 } });
    expect(plan.strategy).toBe('tracked');

    const path = normalizeCropPath(plan);
    expect(path.moves).toBe(true);

    const x = cropPathExpression(path.x);
    const y = cropPathExpression(path.y);

    for (let t = 0; t <= 31; t += 0.1) {
      expect(cropWindowFits({ x: evaluate(x, t), y: evaluate(y, t), ...path.window }, SOURCE)).toBe(true);
    }
  });

  it('keeps the crop window exactly 9:16', () => {
    const plan = buildCropPath(observations, { source: SOURCE, range: { startSec: 10, endSec: 40 } });
    const { window } = normalizeCropPath(plan);

    expect(window.width * 16).toBe(window.height * 9);
    expect(window.width / window.height).toBe(SHORTS_ASPECT_RATIO);
  });

  it('produces a filter chain short enough for one command line', () => {
    const plan = buildCropPath(observations, { source: SOURCE, range: { startSec: 10, endSec: 40 } });
    const chain = videoFilterChain(withCropPlan(DEFAULT_RENDER_PROFILE, plan))!;

    // Windows caps a command line at 32767 characters; the filter chain is by
    // far its largest part, and a path this long is a worst case.
    expect(chain.length).toBeLessThan(16_000);
  });
});
