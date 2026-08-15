/**
 * Unit coverage for the two seams inside `renderClipPlan` that can be tested
 * without FFmpeg: tracking → crop plan, and crop plan → burned-in captions.
 *
 * `trackedCropPlan` is the pure-async slice that decides between a tracked crop
 * and the centre-crop fallback, so it is exercised directly against the
 * existing test trackers; `withBurnedSubtitles` is pure. The real-render proofs
 * live in `render-clip-render.test.ts` and `render-pipeline-e2e.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { trackedCropPlan } from '@/pipeline/render-clip';
import { withBurnedSubtitles } from '@/media/subtitle-burn';
import { videoFilterChain, DEFAULT_RENDER_PROFILE } from '@/media/clip-render';
import { centerCropProfile } from '@/media/reframe';
import {
  CenterSubjectTracker,
  FixtureSubjectTracker,
  NullSubjectTracker,
  type SubjectObservation,
  type SubjectTracker,
  type TrackingResult,
} from '@/tracking';
import type { Dimensions } from '@/domain';

const SOURCE: Dimensions = { width: 1920, height: 1080 };
const RANGE = { startSec: 10, endSec: 20 };

const at = (atSec: number, centerX: number, confidence = 1): SubjectObservation => ({
  atSec,
  x: centerX - 100,
  y: 240,
  width: 200,
  height: 600,
  confidence,
  subjectId: null,
});

const input = (tracker: SubjectTracker) => ({
  videoPath: '/videos/source.mp4',
  range: RANGE,
  source: SOURCE,
  minConfidence: 0.4,
  trackerId: tracker.id,
});

describe('trackedCropPlan', () => {
  it('follows a moving subject when the tracker reports confident observations', async () => {
    const tracker = new FixtureSubjectTracker({
      id: 'fixture-moving',
      observations: [at(10, 400), at(15, 960), at(20, 1500)],
    });

    const plan = await trackedCropPlan(tracker, input(tracker));

    expect(plan.strategy).toBe('tracked');
    expect(plan.rationale).toContain('fixture-moving');
    // The window actually moved: first and last keyframes differ in x.
    expect(plan.keyframes[0]!.x).not.toBe(plan.keyframes.at(-1)!.x);
  });

  it('falls back to a centre crop when the tracker finds nothing', async () => {
    const tracker = new NullSubjectTracker();

    const plan = await trackedCropPlan(tracker, input(tracker));

    expect(plan.rationale).toMatch(/no confident subject/i);
    expect(plan.keyframes).toHaveLength(1);
    expect(plan.keyframes[0]!.confidence).toBe(0);
  });

  it('falls back to a centre crop when every observation is below the confidence floor', async () => {
    const tracker = new FixtureSubjectTracker({
      id: 'fixture-unsure',
      observations: [at(10, 400, 0.1), at(15, 960, 0.1), at(20, 1500, 0.1)],
    });

    const plan = await trackedCropPlan(tracker, input(tracker));

    expect(plan.rationale).toMatch(/no confident subject/i);
    expect(plan.keyframes).toHaveLength(1);
  });

  it('falls back to a centre crop when the tracker throws, despite its contract', async () => {
    const tracker: SubjectTracker = {
      id: 'broken',
      track: () => Promise.reject(new Error('decoder exploded')),
    };
    const warn = vi.fn();

    const plan = await trackedCropPlan(tracker, { ...input(tracker), logger: { debug: vi.fn(), warn } });

    expect(plan.rationale).toMatch(/no confident subject/i);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/falling back/i),
      expect.objectContaining({ tracker: 'broken', reason: 'decoder exploded' }),
    );
  });

  it('a stationary but confident subject still produces a valid (static) crop plan', async () => {
    const tracker = new CenterSubjectTracker();

    const plan = await trackedCropPlan(tracker, input(tracker));

    expect(plan.strategy).toBe('static');
    expect(plan.keyframes[0]!.confidence).toBe(1);
  });

  it('never throws even when the frame source path is unusable', async () => {
    const tracker: SubjectTracker = {
      id: 'flaky',
      track: (): Promise<TrackingResult> => {
        throw new Error('ENOENT: source missing');
      },
    };

    await expect(trackedCropPlan(tracker, input(tracker))).resolves.toMatchObject({ strategy: 'static' });
  });
});

describe('withBurnedSubtitles', () => {
  it('burns captions after the scale, so text is rasterised at output resolution', () => {
    const { profile } = centerCropProfile({ source: SOURCE });
    expect(profile.scale).toEqual({ width: 1080, height: 1920 });

    const burned = withBurnedSubtitles(profile, '/tmp/x/captions.ass');
    const chain = videoFilterChain(burned)!;

    // crop → scale → subtitles, in that order and once each.
    expect(chain.indexOf('crop=')).toBeLessThan(chain.indexOf('scale=1080:1920'));
    expect(chain.indexOf('scale=1080:1920')).toBeLessThan(chain.indexOf('subtitles='));
    expect(chain.match(/scale=/gu)).toHaveLength(1);

    // The pending scale was consumed, not left to be appended a second time.
    expect(burned.scale).toBeNull();
  });

  it('appends the burn-in when there is nothing to scale', () => {
    const burned = withBurnedSubtitles(DEFAULT_RENDER_PROFILE, '/tmp/x/captions.ass');

    expect(videoFilterChain(burned)).toBe("subtitles=filename='/tmp/x/captions.ass'");
  });

  it('quotes a Windows path so the drive colon is not read as an option separator', () => {
    const burned = withBurnedSubtitles(DEFAULT_RENDER_PROFILE, 'C:\\storage\\renders\\.subs-a\\captions.ass');

    expect(videoFilterChain(burned)).toBe(
      "subtitles=filename='C\\:/storage/renders/.subs-a/captions.ass'",
    );
  });

  it('leaves audio settings untouched, so the speech is the source’s', () => {
    const { profile } = centerCropProfile({ source: SOURCE });
    const burned = withBurnedSubtitles(profile, '/tmp/x/captions.ass');

    expect(burned.audioCodec).toBe(DEFAULT_RENDER_PROFILE.audioCodec);
    expect(burned.audioBitrate).toBe(DEFAULT_RENDER_PROFILE.audioBitrate);
    expect(burned.audioSampleRateHz).toBe(DEFAULT_RENDER_PROFILE.audioSampleRateHz);
  });
});
