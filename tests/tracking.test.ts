import { describe, expect, it } from 'vitest';
import {
  buildCropPath,
  centerFallback,
  CenterSubjectTracker,
  FixtureSubjectTracker,
  isUsableObservation,
  NullSubjectTracker,
  observationCenter,
  type SubjectObservation,
  type SubjectTracker,
  type TrackingRequest,
} from '@/tracking';
import {
  cropWindowAt,
  clampCropWindow,
  cropWindowFits,
  isCropPlanValid,
  largestCenteredWindow,
  SHORTS_ASPECT_RATIO,
  SHORTS_OUTPUT,
  type CropPlan,
  type Dimensions,
} from '@/domain';

const SOURCE: Dimensions = { width: 1920, height: 1080 };
const RANGE = { startSec: 10, endSec: 40 };
/** 594×1056 for a 1920×1080 source — the centre-crop window from phase 5. */
const WINDOW = largestCenteredWindow(SOURCE, SHORTS_OUTPUT)!;

/** A subject box centred on `centerX`, at a fixed size. */
const at = (atSec: number, centerX: number, confidence = 1, subjectId: string | null = null): SubjectObservation => ({
  atSec,
  x: centerX - 100,
  y: 240,
  width: 200,
  height: 600,
  confidence,
  subjectId,
});

const path = (observations: readonly SubjectObservation[], options = {}) =>
  buildCropPath(observations, { source: SOURCE, range: RANGE, ...options });

const centerOf = (window: { x: number; width: number }) => window.x + window.width / 2;

/* -------------------------------------------------------------------------- */
/* Trackers                                                                   */
/* -------------------------------------------------------------------------- */

describe('CenterSubjectTracker', () => {
  const request: TrackingRequest = { videoPath: '/videos/source.mp4', range: RANGE, source: SOURCE };

  it('reports a centred subject across the whole range', async () => {
    const { observations, trackerId } = await new CenterSubjectTracker().track(request);

    expect(trackerId).toBe('center');
    expect(observations.length).toBeGreaterThan(1);
    expect(observations[0]!.atSec).toBe(RANGE.startSec);
    expect(observations.at(-1)!.atSec).toBe(RANGE.endSec);

    for (const observation of observations) {
      expect(observationCenter(observation).x).toBe(SOURCE.width / 2);
      expect(observation.confidence).toBe(1);
      expect(isUsableObservation(observation, SOURCE)).toBe(true);
    }
  });

  it('is deterministic: the same request twice gives identical observations', async () => {
    const tracker = new CenterSubjectTracker();
    expect(await tracker.track(request)).toEqual(await tracker.track(request));
  });

  it('honours the requested interval', async () => {
    const { observations } = await new CenterSubjectTracker().track({ ...request, intervalSec: 5 });
    expect(observations.map((o) => o.atSec)).toEqual([10, 15, 20, 25, 30, 35, 40]);
  });

  it('returns nothing for an empty range rather than throwing', async () => {
    const { observations } = await new CenterSubjectTracker().track({
      ...request,
      range: { startSec: 10, endSec: 10 },
    });
    expect(observations).toEqual([]);
  });
});

describe('FixtureSubjectTracker', () => {
  it('replays only the observations inside the requested range', async () => {
    const tracker = new FixtureSubjectTracker({ observations: [at(5, 500), at(20, 600), at(50, 700)] });
    const { observations } = await tracker.track({ videoPath: 'v.mp4', range: RANGE, source: SOURCE });

    expect(observations.map((o) => o.atSec)).toEqual([20]);
  });

  it('returns them in ascending time order whatever order they were given', async () => {
    const tracker = new FixtureSubjectTracker({ observations: [at(30, 500), at(12, 600), at(20, 700)] });
    const { observations } = await tracker.track({ videoPath: 'v.mp4', range: RANGE, source: SOURCE });

    expect(observations.map((o) => o.atSec)).toEqual([12, 20, 30]);
  });
});

describe('NullSubjectTracker', () => {
  it('finds nothing, which is a valid answer', async () => {
    // Through the interface, to prove it is a drop-in for any other tracker.
    const tracker: SubjectTracker = new NullSubjectTracker();
    const result = await tracker.track({ videoPath: 'v.mp4', range: RANGE, source: SOURCE });

    expect(result.observations).toEqual([]);
    expect(buildCropPath(result.observations, { source: SOURCE, range: RANGE }).strategy).toBe('static');
  });
});

/* -------------------------------------------------------------------------- */
/* Fallback to centre                                                         */
/* -------------------------------------------------------------------------- */

describe('fallback to centre crop', () => {
  const isCentred = (plan: CropPlan) => {
    expect(plan.strategy).toBe('static');
    expect(plan.keyframes).toHaveLength(1);
    expect(plan.keyframes[0]!).toMatchObject({ atSec: 0, ...WINDOW });
  };

  it('falls back when there are no observations at all', () => {
    isCentred(path([]));
  });

  it('falls back when every observation is below the confidence floor', () => {
    isCentred(path([at(12, 300, 0.1), at(20, 1600, 0.2), at(30, 400, 0.39)]));
  });

  it('falls back when every observation is outside the clip range', () => {
    isCentred(path([at(2, 300), at(90, 1600)]));
  });

  it('falls back on a range with no duration', () => {
    isCentred(buildCropPath([at(10, 300)], { source: SOURCE, range: { startSec: 10, endSec: 10 } }));
  });

  it('falls back on observations that are not usable geometry', () => {
    isCentred(
      path([
        { ...at(12, 300), width: 0 },
        { ...at(20, 300), x: Number.NaN },
        { ...at(30, 300), confidence: Number.NaN },
        { ...at(35, 300), x: -400, width: 100 },
      ]),
    );
  });

  it('marks the fallback as untracked rather than pretending it followed something', () => {
    const plan = path([]);
    expect(plan.keyframes[0]!.confidence).toBe(0);
    expect(plan.rationale).toMatch(/no confident subject/i);
  });

  it('throws only when the geometry is impossible', () => {
    expect(() => centerFallback({ width: 10, height: 10 })).toThrowError(/aspect ratio/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Tracking a moving subject                                                  */
/* -------------------------------------------------------------------------- */

describe('tracked paths', () => {
  it('produces a tracked plan with multiple keyframes for a moving subject', () => {
    const plan = path([at(10, 400), at(25, 960), at(40, 1500)]);

    expect(plan.strategy).toBe('tracked');
    expect(plan.keyframes.length).toBeGreaterThan(2);
    expect(plan.rationale).toMatch(/follows the subject/i);
  });

  it('follows the subject: the window ends further right than it began', () => {
    const plan = path([at(10, 400), at(25, 960), at(40, 1500)]);

    expect(plan.keyframes.at(-1)!.x).toBeGreaterThan(plan.keyframes[0]!.x);
  });

  it('collapses a stationary subject to a single static keyframe', () => {
    const plan = path([at(10, 960), at(25, 960), at(40, 960)]);

    expect(plan.strategy).toBe('static');
    expect(plan.keyframes).toHaveLength(1);
    expect(plan.rationale).toMatch(/did not move/i);
  });

  it('keeps every window the exact 9:16 crop size', () => {
    const plan = path([at(10, 300), at(25, 1600), at(40, 500)]);

    for (const kf of plan.keyframes) {
      expect(kf.width).toBe(WINDOW.width);
      expect(kf.height).toBe(WINDOW.height);
      expect(kf.width * 16).toBe(kf.height * 9);
    }
    expect(plan.targetAspectRatio).toBe(SHORTS_ASPECT_RATIO);
  });

  it('emits keyframes on the clip timeline, ascending, spanning the clip', () => {
    const plan = path([at(10, 300), at(25, 1600)]);

    expect(plan.keyframes[0]!.atSec).toBe(0);
    expect(plan.keyframes.at(-1)!.atSec).toBe(RANGE.endSec - RANGE.startSec);

    const times = plan.keyframes.map((kf) => kf.atSec);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });

  it('passes the domain plan validator', () => {
    const plan = path([at(10, 300), at(25, 1600), at(40, 700)]);
    expect(isCropPlanValid(plan, { startSec: 0, endSec: RANGE.endSec - RANGE.startSec })).toBe(true);
  });

  it('carries the subject identity through to the keyframes', () => {
    const plan = path([at(10, 400, 1, 'speaker-a'), at(25, 900, 1, 'speaker-a'), at(40, 1500, 1, 'speaker-a')]);
    expect(plan.keyframes.every((kf) => kf.subjectId === 'speaker-a')).toBe(true);
  });

  it('records the tracker in the rationale', () => {
    expect(path([at(10, 400), at(40, 1500)], { trackerId: 'fixture' }).rationale).toContain('"fixture"');
  });
});

/* -------------------------------------------------------------------------- */
/* Keyframe interpolation                                                     */
/* -------------------------------------------------------------------------- */

describe('keyframe interpolation', () => {
  const plan = path([at(10, 300), at(40, 1600)]);

  it('interpolates linearly between keyframes', () => {
    const a = plan.keyframes[0]!;
    const b = plan.keyframes[1]!;
    const middle = cropWindowAt(plan, (a.atSec + b.atSec) / 2);

    expect(middle.x).toBeGreaterThanOrEqual(Math.min(a.x, b.x));
    expect(middle.x).toBeLessThanOrEqual(Math.max(a.x, b.x));
    expect(Math.abs(middle.x - (a.x + b.x) / 2)).toBeLessThanOrEqual(2);
  });

  it('holds the first window before the path starts and the last after it ends', () => {
    expect(cropWindowAt(plan, -5).x).toBe(plan.keyframes[0]!.x);
    expect(cropWindowAt(plan, 9_999).x).toBe(plan.keyframes.at(-1)!.x);
  });

  it('returns the single window of a static plan at any instant', () => {
    const still = path([]);
    expect(cropWindowAt(still, 0)).toMatchObject(WINDOW);
    expect(cropWindowAt(still, 17.3)).toMatchObject(WINDOW);
  });

  it('never interpolates its way outside the source frame', () => {
    const moving = path([at(10, 40), at(25, 1880), at(40, 60)]);

    for (let t = 0; t <= 30; t += 0.25) {
      expect(cropWindowFits(cropWindowAt(moving, t), SOURCE)).toBe(true);
    }
  });

  it('yields even coordinates at every interpolated instant', () => {
    for (let t = 0; t <= 30; t += 0.37) {
      const window = cropWindowAt(plan, t);
      expect(window.x % 2).toBe(0);
      expect(window.y % 2).toBe(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* -------------------------------------------------------------------------- */

describe('crop-bound clamping', () => {
  it('never lets the window leave the frame, however extreme the subject', () => {
    const plan = path([at(10, -500), at(20, 3000), at(30, 0), at(40, 1920)]);

    for (const kf of plan.keyframes) {
      expect(kf.x).toBeGreaterThanOrEqual(0);
      expect(kf.y).toBeGreaterThanOrEqual(0);
      expect(cropWindowFits(kf, SOURCE)).toBe(true);
    }
  });

  it('pins the window to the left edge for a subject at the far left', () => {
    const plan = path([at(10, 20), at(25, 20), at(40, 20)]);
    expect(plan.keyframes[0]!.x).toBe(0);
  });

  it('pins the window to the right edge for a subject at the far right', () => {
    const plan = path([at(10, 1900), at(25, 1900), at(40, 1900)]);
    expect(plan.keyframes[0]!.x).toBe(SOURCE.width - WINDOW.width);
  });

  it('keeps every coordinate even, for chroma alignment', () => {
    const plan = path([at(10, 371), at(25, 1113), at(40, 655)]);

    for (const kf of plan.keyframes) {
      expect(kf.x % 2).toBe(0);
      expect(kf.y % 2).toBe(0);
    }
  });

  it('clampCropWindow moves a window inside without resizing it', () => {
    const clamped = clampCropWindow({ ...WINDOW, x: -300, y: 5000 }, SOURCE);

    expect(clamped).toEqual({ x: 0, y: SOURCE.height - WINDOW.height, width: WINDOW.width, height: WINDOW.height });
  });
});

/* -------------------------------------------------------------------------- */
/* Smoothing                                                                  */
/* -------------------------------------------------------------------------- */

describe('smoothing', () => {
  /** A subject that teleports left↔right — the classic whip-pan trigger. */
  const jumpy = [at(10, 200), at(11, 1700), at(12, 200), at(13, 1700), at(14, 200), at(40, 200)];

  it('turns a jumping subject into a path that never jumps', () => {
    const plan = path(jumpy);
    const maxPanPerSec = 0.12 * SOURCE.width;

    for (let i = 1; i < plan.keyframes.length; i += 1) {
      const previous = plan.keyframes[i - 1]!;
      const current = plan.keyframes[i]!;
      const dt = current.atSec - previous.atSec;

      // Two pixels of slack for even-alignment rounding.
      expect(Math.abs(current.x - previous.x)).toBeLessThanOrEqual(maxPanPerSec * dt + 2);
    }
  });

  it('damps the amplitude of an oscillating subject rather than chasing it', () => {
    const plan = path(jumpy);
    const travelled = Math.max(...plan.keyframes.map((kf) => kf.x)) - Math.min(...plan.keyframes.map((kf) => kf.x));

    // The raw subject swings 1500px; a followed-exactly window would too.
    expect(travelled).toBeLessThan(1500);
  });

  it('pans harder when allowed to and less when not', () => {
    const gentle = path(jumpy, { maxPanFractionPerSec: 0.01 });
    const brisk = path(jumpy, { maxPanFractionPerSec: 0.5 });

    const spread = (plan: CropPlan) =>
      Math.max(...plan.keyframes.map((kf) => kf.x)) - Math.min(...plan.keyframes.map((kf) => kf.x));

    expect(spread(gentle)).toBeLessThan(spread(brisk));
  });

  it('a longer half-life produces a lazier camera', () => {
    const observations = [at(10, 300), at(20, 1600), at(40, 1600)];
    const snappy = path(observations, { smoothingHalfLifeSec: 0.2 });
    const lazy = path(observations, { smoothingHalfLifeSec: 5 });

    const atTen = (plan: CropPlan) => cropWindowAt(plan, 10).x;
    expect(atTen(snappy)).toBeGreaterThan(atTen(lazy));
  });

  it('still keeps the subject inside the window despite the lag', () => {
    // A move the camera can physically make (70px/s, well under the pan limit)
    // paired with heavy smoothing: the lag must not cost us the subject.
    const observations = [at(10, 300), at(20, 1000), at(40, 1000)];
    const plan = path(observations, { smoothingHalfLifeSec: 5 });

    // Sampled at the subject's own instants: smoothing may lag, but never so
    // far that the subject leaves the frame.
    for (const observation of observations) {
      const window = cropWindowAt(plan, observation.atSec - RANGE.startSec);
      const subjectFits = observation.width <= window.width;
      if (!subjectFits) continue;

      expect(window.x).toBeLessThanOrEqual(observation.x + 2);
      expect(window.x + window.width).toBeGreaterThanOrEqual(observation.x + observation.width - 2);
    }
  });

  it('centres on a subject too wide to contain instead of giving up', () => {
    const wide: SubjectObservation = { atSec: 25, x: 0, y: 0, width: 1920, height: 1080, confidence: 1, subjectId: null };
    const plan = path([at(10, 960), wide, at(40, 960)]);

    expect(Math.abs(centerOf(plan.keyframes[0]!) - SOURCE.width / 2)).toBeLessThanOrEqual(4);
  });
});

/* -------------------------------------------------------------------------- */
/* Missing and low-confidence observations                                    */
/* -------------------------------------------------------------------------- */

describe('missing and low-confidence observations', () => {
  it('bridges a gap in the middle of the clip', () => {
    // Nothing between 13s and 37s: the path must still cover the whole clip.
    const plan = path([at(10, 300), at(13, 400), at(37, 1500), at(40, 1600)]);

    expect(plan.keyframes[0]!.atSec).toBe(0);
    expect(plan.keyframes.at(-1)!.atSec).toBe(30);
    expect(plan.keyframes.every((kf) => cropWindowFits(kf, SOURCE))).toBe(true);
  });

  it('holds the last known position after the observations stop', () => {
    const plan = path([at(10, 1600), at(15, 1600)]);
    const settled = cropWindowAt(plan, 28).x;

    expect(Math.abs(settled - plan.keyframes.at(-1)!.x)).toBeLessThanOrEqual(2);
  });

  it('ignores low-confidence observations but keeps the confident ones', () => {
    const withNoise = path([at(10, 300), at(25, 1800, 0.05), at(40, 400)]);
    const withoutNoise = path([at(10, 300), at(40, 400)]);

    expect(withNoise.keyframes).toEqual(withoutNoise.keyframes);
  });

  it('respects a custom confidence floor', () => {
    const observations = [at(10, 300, 0.5), at(25, 1600, 0.5), at(40, 300, 0.5)];

    expect(path(observations, { minConfidence: 0.9 }).strategy).toBe('static');
    expect(path(observations, { minConfidence: 0.3 }).strategy).toBe('tracked');
  });

  it('reports lower confidence on keyframes that bridge a doubtful stretch', () => {
    const plan = path([at(10, 300, 1), at(40, 1600, 0.5)]);
    const confidences = plan.keyframes.map((kf) => kf.confidence!);

    expect(confidences[0]).toBeCloseTo(1, 5);
    expect(confidences.at(-1)).toBeCloseTo(0.5, 5);
    expect(Math.max(...confidences)).toBeLessThanOrEqual(1);
    expect(Math.min(...confidences)).toBeGreaterThanOrEqual(0);
  });

  it('survives a single observation', () => {
    const plan = path([at(25, 1600)]);

    expect(plan.keyframes.length).toBeGreaterThanOrEqual(1);
    expect(plan.keyframes.every((kf) => cropWindowFits(kf, SOURCE))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  const observations = [at(10, 300), at(18, 1200), at(26, 700), at(40, 1500)];

  it('gives byte-identical plans for identical input', () => {
    expect(path(observations)).toEqual(path(observations));
  });

  it('does not depend on the order observations arrive in', () => {
    const shuffled = [observations[2]!, observations[0]!, observations[3]!, observations[1]!];
    expect(path(shuffled)).toEqual(path(observations));
  });

  it('produces integer coordinates only', () => {
    for (const kf of path(observations).keyframes) {
      expect(Number.isInteger(kf.x)).toBe(true);
      expect(Number.isInteger(kf.y)).toBe(true);
      expect(Number.isInteger(kf.width)).toBe(true);
      expect(Number.isInteger(kf.height)).toBe(true);
    }
  });

  it('round-trips through JSON unchanged, so a stored plan renders the same', () => {
    const plan = path(observations);
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it('is deterministic end to end from the development tracker', async () => {
    const tracker = new CenterSubjectTracker();
    const request: TrackingRequest = { videoPath: 'v.mp4', range: RANGE, source: SOURCE };

    const once = buildCropPath((await tracker.track(request)).observations, {
      source: SOURCE,
      range: RANGE,
      trackerId: tracker.id,
    });
    const twice = buildCropPath((await tracker.track(request)).observations, {
      source: SOURCE,
      range: RANGE,
      trackerId: tracker.id,
    });

    expect(once).toEqual(twice);
    // A centred subject is the centre crop, arrived at the long way round.
    expect(once.keyframes[0]!).toMatchObject(WINDOW);
  });
});
