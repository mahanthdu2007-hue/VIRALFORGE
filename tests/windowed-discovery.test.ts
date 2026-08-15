/**
 * Windowed discovery: the seam behaviour, and the promise that short videos
 * take exactly the path they always did.
 *
 * The point of windowing is a bigger candidate pool for a long source, and the
 * risk of windowing is that it changes the pool for sources that were already
 * fine. Both are asserted here directly.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CandidateClipDraft, ClipDiscoveryCapability, ClipDiscoveryRequest } from '@/ai/types';
import { EMPTY_CLIP_SIGNALS } from '@/domain';
import {
  discoverAcrossWindows,
  mergeDrafts,
  planWindows,
  WINDOWED_DISCOVERY_DEFAULTS,
} from '@/pipeline/windowed-discovery';

/* -------------------------------------------------------------------------- */

const draft = (over: Partial<CandidateClipDraft> = {}): CandidateClipDraft => ({
  startSec: 0,
  endSec: 30,
  hookQuote: 'a line',
  topic: 'a topic',
  reason: 'because',
  signals: EMPTY_CLIP_SIGNALS,
  ...over,
});

/** A transcript of `count` fifteen-second segments, as discovery receives it. */
const segments = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    startSec: i * 15,
    endSec: (i + 1) * 15,
    text: `segment ${i} words here`,
  }));

const request = (over: Partial<ClipDiscoveryRequest> = {}): ClipDiscoveryRequest => ({
  segments: segments(8),
  videoDurationSec: 120,
  maxCandidates: 12,
  targetDurationSec: { min: 20, max: 60 },
  ...over,
});

/* -------------------------------------------------------------------------- */

describe('planWindows', () => {
  it('reads a short source in a single window', () => {
    const windows = planWindows(request(), 600, 90);

    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({ startSec: 0, endSec: 120 });
  });

  it('splits a long source into overlapping windows that reach the end', () => {
    const long = request({ segments: segments(128), videoDurationSec: 1920 });
    const windows = planWindows(long, 600, 90);

    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]!.startSec).toBe(0);
    expect(windows[windows.length - 1]!.endSec).toBe(1920);

    // Consecutive windows genuinely share time, and the shared stretch is wider
    // than the longest candidate a window may return.
    for (const [i, window] of windows.slice(1).entries()) {
      const previous = windows[i]!;
      expect(window.startSec).toBeLessThan(previous.endSec);
      expect(previous.endSec - window.startSec).toBeGreaterThanOrEqual(60);
    }
  });

  it('covers every second of the source across the windows', () => {
    const long = request({ segments: segments(128), videoDurationSec: 1920 });
    const windows = planWindows(long, 600, 90);

    let reached = 0;
    for (const window of windows) {
      expect(window.startSec).toBeLessThanOrEqual(reached);
      reached = Math.max(reached, window.endSec);
    }
    expect(reached).toBe(1920);
  });

  it('never returns an empty plan, whatever the numbers', () => {
    expect(planWindows(request({ segments: [], videoDurationSec: 0 }), 600, 90)).toHaveLength(1);
    expect(planWindows(request(), 0, 90).length).toBeGreaterThan(0);
    // Overlap wider than the window would stall a naive stride.
    expect(planWindows(request({ videoDurationSec: 3000 }), 600, 5000).length).toBeGreaterThan(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('mergeDrafts', () => {
  const { duplicateOverlapRatio: ratio, duplicateTextSimilarity: similarity } = WINDOWED_DISCOVERY_DEFAULTS;

  it('drops the same moment proposed by two windows', () => {
    const merged = mergeDrafts(
      [
        draft({ startSec: 100, endSec: 130, hookQuote: 'the same line' }),
        draft({ startSec: 102, endSec: 131, hookQuote: 'the same line' }),
      ],
      ratio,
      similarity,
    );

    expect(merged).toHaveLength(1);
  });

  it('treats an identical hook quote as the same moment even at different bounds', () => {
    const merged = mergeDrafts(
      [
        draft({ startSec: 100, endSec: 130, hookQuote: 'I never expected that' }),
        draft({ startSec: 400, endSec: 430, hookQuote: 'I never expected that!' }),
      ],
      ratio,
      similarity,
    );

    expect(merged).toHaveLength(1);
  });

  it('keeps genuinely different moments that merely sit near each other', () => {
    const merged = mergeDrafts(
      [
        draft({ startSec: 100, endSec: 130, hookQuote: 'first point', topic: 'money' }),
        draft({ startSec: 140, endSec: 170, hookQuote: 'second point', topic: 'health' }),
      ],
      ratio,
      similarity,
    );

    expect(merged).toHaveLength(2);
  });

  it('keeps same-topic moments from different parts of the video', () => {
    const merged = mergeDrafts(
      [
        draft({ startSec: 100, endSec: 130, hookQuote: 'one', topic: 'training hard' }),
        draft({ startSec: 900, endSec: 930, hookQuote: 'two', topic: 'training hard' }),
      ],
      ratio,
      similarity,
    );

    expect(merged).toHaveLength(2);
  });

  it('returns drafts in source order and is deterministic', () => {
    const input = [
      draft({ startSec: 300, endSec: 330, hookQuote: 'c' }),
      draft({ startSec: 100, endSec: 130, hookQuote: 'a' }),
      draft({ startSec: 200, endSec: 230, hookQuote: 'b' }),
    ];

    const merged = mergeDrafts(input, ratio, similarity);
    expect(merged.map((d) => d.startSec)).toEqual([100, 200, 300]);
    expect(mergeDrafts(input, ratio, similarity)).toEqual(merged);
  });
});

/* -------------------------------------------------------------------------- */

describe('discoverAcrossWindows', () => {
  const capability = (impl: ClipDiscoveryCapability['discoverClips']): ClipDiscoveryCapability => ({
    discoverClips: vi.fn(impl),
  });

  it('makes exactly one unchanged request for a short source', async () => {
    const discovery = capability(async () => [draft()]);
    const input = request();

    await discoverAcrossWindows(discovery, input);

    expect(discovery.discoverClips).toHaveBeenCalledTimes(1);
    expect(discovery.discoverClips).toHaveBeenCalledWith(input);
  });

  it('asks each window separately for a long source', async () => {
    const seen: number[] = [];
    const discovery = capability(async (r) => {
      seen.push(r.segments.length);
      return [draft({ startSec: r.segments[0]!.startSec, endSec: r.segments[0]!.startSec + 30 })];
    });

    await discoverAcrossWindows(
      discovery,
      request({ segments: segments(128), videoDurationSec: 1920 }),
    );

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((count) => count > 0)).toBe(true);
  });

  it('gives every window the full candidate budget and the whole video duration', async () => {
    const discovery = capability(async (r) => {
      expect(r.maxCandidates).toBe(12);
      // Absolute timestamps only make sense against the real duration.
      expect(r.videoDurationSec).toBe(1920);
      return [];
    });

    await discoverAcrossWindows(
      discovery,
      request({ segments: segments(128), videoDurationSec: 1920, maxCandidates: 12 }),
    );
  });

  it('returns a bigger pool than a single request would', async () => {
    let window = 0;
    const discovery = capability(async () => {
      const base = window * 1000;
      window += 1;
      return Array.from({ length: 12 }, (_, i) =>
        draft({ startSec: base + i * 40, endSec: base + i * 40 + 30, hookQuote: `quote ${base + i}` }),
      );
    });

    const merged = await discoverAcrossWindows(
      discovery,
      request({ segments: segments(128), videoDurationSec: 1920 }),
    );

    expect(merged.length).toBeGreaterThan(12);
  });

  it('survives one failing window and keeps the rest', async () => {
    let call = 0;
    const discovery = capability(async (r) => {
      call += 1;
      if (call === 2) throw new Error('gateway timeout');
      return [draft({ startSec: r.segments[0]!.startSec, endSec: r.segments[0]!.startSec + 30, hookQuote: `q${call}` })];
    });

    const merged = await discoverAcrossWindows(
      discovery,
      request({ segments: segments(128), videoDurationSec: 1920 }),
    );

    expect(merged.length).toBeGreaterThan(0);
  });

  it('throws when every window fails rather than reporting no good moments', async () => {
    const discovery = capability(async () => {
      throw new Error('provider down');
    });

    await expect(
      discoverAcrossWindows(discovery, request({ segments: segments(128), videoDurationSec: 1920 })),
    ).rejects.toThrow(/all \d+ transcript windows/u);
  });

  it('runs windows one at a time, never concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    const discovery = capability(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return [];
    });

    await discoverAcrossWindows(
      discovery,
      request({ segments: segments(128), videoDurationSec: 1920 }),
    );

    expect(peak).toBe(1);
  });
});
