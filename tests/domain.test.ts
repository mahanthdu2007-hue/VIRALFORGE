import { describe, expect, it } from 'vitest';
import {
  clipPlanDuration,
  isCropPlanValid,
  isUnitScore,
  isValidRange,
  isWithinShortDuration,
  rangeDuration,
  rangesOverlap,
  SHORT_MAX_DURATION_SEC,
  SHORT_MIN_DURATION_SEC,
  SHORTS_ASPECT_RATIO,
  subtitleText,
  transcriptText,
  type ClipPlan,
  type CropPlan,
  type SubtitleSegment,
  type Transcript,
} from '@/domain';
import { makeClipPlan, makeTranscript } from './helpers/fixtures';

describe('time ranges', () => {
  it('measures duration', () => {
    expect(rangeDuration({ startSec: 10, endSec: 42.5 })).toBe(32.5);
  });

  it.each([
    [{ startSec: 0, endSec: 1 }, true],
    [{ startSec: 5, endSec: 5 }, false],
    [{ startSec: 5, endSec: 4 }, false],
    [{ startSec: -1, endSec: 4 }, false],
    [{ startSec: 0, endSec: Number.NaN }, false],
  ])('validates %j', (range, expected) => {
    expect(isValidRange(range)).toBe(expected);
  });

  it('detects overlap but treats touching ranges as disjoint', () => {
    expect(rangesOverlap({ startSec: 0, endSec: 10 }, { startSec: 9, endSec: 20 })).toBe(true);
    expect(rangesOverlap({ startSec: 0, endSec: 10 }, { startSec: 10, endSec: 20 })).toBe(false);
  });
});

describe('unit scores', () => {
  it.each([
    [0, true],
    [1, true],
    [0.42, true],
    [-0.1, false],
    [1.1, false],
    [Number.NaN, false],
    ['0.5', false],
  ])('validates %s', (value, expected) => {
    expect(isUnitScore(value)).toBe(expected);
  });
});

describe('transcript', () => {
  it('joins segments verbatim, in order', () => {
    const transcript: Transcript = makeTranscript([
      { startSec: 0, endSec: 2, text: 'We tried it anyway.' },
      { startSec: 2, endSec: 5, text: 'It worked.' },
    ]);

    expect(transcriptText(transcript)).toBe('We tried it anyway. It worked.');
  });
});

describe('clip plan', () => {
  it('sums cut durations, not the outer span', () => {
    const plan: ClipPlan = makeClipPlan([
      { startSec: 100, endSec: 120, order: 0 },
      { startSec: 140, endSec: 155, order: 1 },
    ]);

    expect(clipPlanDuration(plan)).toBe(35);
  });

  it.each([
    [SHORT_MIN_DURATION_SEC, true],
    [SHORT_MAX_DURATION_SEC, true],
    [35, true],
    [29.9, false],
    [41, false],
  ])('gates %ss against the Shorts window', (duration, expected) => {
    expect(isWithinShortDuration(duration)).toBe(expected);
  });
});

describe('subtitles', () => {
  it('flattens display lines back to one string', () => {
    const cue: SubtitleSegment = {
      index: 0,
      startSec: 0,
      endSec: 2,
      lines: ['This is the part', 'nobody expected.'],
      words: null,
    };

    expect(subtitleText(cue)).toBe('This is the part nobody expected.');
  });
});

describe('crop plan', () => {
  const clipRange = { startSec: 0, endSec: 30 };
  const base: CropPlan = {
    strategy: 'static',
    source: { width: 2560, height: 1920 },
    output: { width: 1080, height: 1920 },
    targetAspectRatio: SHORTS_ASPECT_RATIO,
    keyframes: [{ atSec: 0, x: 420, y: 0, width: 1080, height: 1920 }],
    rationale: null,
  };

  it('accepts a single centred static window', () => {
    expect(isCropPlanValid(base, clipRange)).toBe(true);
  });

  it('rejects an empty keyframe list', () => {
    expect(isCropPlanValid({ ...base, keyframes: [] }, clipRange)).toBe(false);
  });

  it('rejects a static plan with more than one keyframe', () => {
    expect(
      isCropPlanValid(
        { ...base, keyframes: [...base.keyframes, { atSec: 5, x: 0, y: 0, width: 1080, height: 1920 }] },
        clipRange,
      ),
    ).toBe(false);
  });

  it('accepts ascending tracked keyframes', () => {
    expect(
      isCropPlanValid(
        {
          ...base,
          strategy: 'tracked',
          keyframes: [
            { atSec: 0, x: 0, y: 0, width: 1080, height: 1920 },
            { atSec: 12, x: 200, y: 0, width: 1080, height: 1920 },
          ],
        },
        clipRange,
      ),
    ).toBe(true);
  });

  it('rejects out-of-order or out-of-range keyframes', () => {
    const outOfOrder: CropPlan = {
      ...base,
      strategy: 'tracked',
      keyframes: [
        { atSec: 10, x: 0, y: 0, width: 1080, height: 1920 },
        { atSec: 4, x: 0, y: 0, width: 1080, height: 1920 },
      ],
    };
    const pastEnd: CropPlan = {
      ...base,
      keyframes: [{ atSec: 45, x: 0, y: 0, width: 1080, height: 1920 }],
    };

    expect(isCropPlanValid(outOfOrder, clipRange)).toBe(false);
    expect(isCropPlanValid(pastEnd, clipRange)).toBe(false);
  });

  it('rejects non-positive dimensions', () => {
    expect(isCropPlanValid({ ...base, keyframes: [{ atSec: 0, x: 0, y: 0, width: 0, height: 1920 }] }, clipRange)).toBe(
      false,
    );
  });
});
