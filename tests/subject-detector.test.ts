/**
 * The real subject detector, without the model, the runtime or the video.
 *
 * Everything that can be wrong about detection and still be found cheaply lives
 * here: the anchor arithmetic YuNet's outputs have to be run through, the
 * letterbox that has to be inverted exactly, the rules that decide one person
 * from two, and the selection that has to degrade to the deterministic tracker
 * when the weights are absent. None of it downloads anything or loads a native
 * binary — `subject-detector-video.test.ts` covers the parts that genuinely
 * need FFmpeg, and `subject-detector-model.test.ts` the parts that genuinely
 * need weights.
 */

import { describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  associateTracks,
  buildCropPath,
  CenterSubjectTracker,
  createSubjectTracker,
  decodeDimensions,
  decodeYuNet,
  detectLuminanceBlobs,
  DetectorSubjectTracker,
  isInstalled,
  isUsableObservation,
  letterboxFrame,
  LuminanceBlobDetector,
  nonMaxSuppression,
  NullSubjectTracker,
  selectPrimaryTrack,
  toFrameCoordinates,
  toSourceCoordinates,
  trackPrimarySubject,
  trackPrimarySubjectWindowed,
  YUNET_INPUT_SIZE,
  YUNET_STRIDES,
  type DetectionFrame,
  type FrameDetection,
  type FrameDetector,
  type FrameSampleRequest,
  type FrameSource,
  type RgbFrame,
  type SampledFrame,
} from '@/tracking';
import { buildSampleArgs } from '@/media/frame-source';
import { cropWindowFits, isCropPlanValid, type Dimensions } from '@/domain';

const SOURCE: Dimensions = { width: 1920, height: 1080 };

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

/** An RGB frame painted by a function of position. */
function paintFrame(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number]): RgbFrame {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 3;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  return { width, height, data };
}

const inside = (x: number, y: number, box: { x: number; y: number; width: number; height: number }): boolean =>
  x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;

interface YuNetAnchor {
  readonly stride: (typeof YUNET_STRIDES)[number];
  readonly column: number;
  readonly row: number;
  readonly cls: number;
  readonly obj: number;
  /** Centre offset in cells, then log-scale width and height. */
  readonly box: readonly [number, number, number, number];
}

/** All twelve heads, zeroed, with the named anchors lit up. */
function yunetOutputs(anchors: readonly YuNetAnchor[]): Record<string, Float32Array> {
  const outputs: Record<string, Float32Array> = {};

  for (const stride of YUNET_STRIDES) {
    const cells = (YUNET_INPUT_SIZE / stride) ** 2;
    outputs[`cls_${stride}`] = new Float32Array(cells);
    outputs[`obj_${stride}`] = new Float32Array(cells);
    outputs[`bbox_${stride}`] = new Float32Array(cells * 4);
  }

  for (const anchor of anchors) {
    const columns = YUNET_INPUT_SIZE / anchor.stride;
    const index = anchor.row * columns + anchor.column;
    outputs[`cls_${anchor.stride}`]![index] = anchor.cls;
    outputs[`obj_${anchor.stride}`]![index] = anchor.obj;
    outputs[`bbox_${anchor.stride}`]!.set(anchor.box, index * 4);
  }

  return outputs;
}

/** A frame source that replays a scripted list and records what it was asked for. */
class ScriptedFrameSource implements FrameSource {
  readonly id = 'scripted';
  readonly requests: FrameSampleRequest[] = [];

  constructor(private readonly samples: readonly SampledFrame[]) {}

  async *frames(request: FrameSampleRequest): AsyncIterable<SampledFrame> {
    this.requests.push(request);
    for (const sample of this.samples.slice(0, Math.floor(request.maxFrames))) yield sample;
  }
}

class ThrowingFrameSource implements FrameSource {
  readonly id = 'throwing';
  async *frames(): AsyncIterable<SampledFrame> {
    throw new Error('ffmpeg exploded');
  }
}

/** Returns whatever the script says for frame *n*, ignoring the pixels. */
class ScriptedDetector implements FrameDetector {
  readonly id = 'scripted';
  private index = 0;

  constructor(private readonly script: readonly (readonly FrameDetection[])[]) {}

  async detect(): Promise<readonly FrameDetection[]> {
    return this.script[this.index++] ?? [];
  }

  async close(): Promise<void> {}
}

class ThrowingDetector implements FrameDetector {
  readonly id = 'throwing';
  async detect(): Promise<readonly FrameDetection[]> {
    throw new Error('model is on fire');
  }
  async close(): Promise<void> {}
}

const blankSample = (atSec: number): SampledFrame => ({
  atSec,
  frame: paintFrame(64, 36, () => [0, 0, 0]),
});

const detection = (over: Partial<FrameDetection> = {}): FrameDetection => ({
  x: 100,
  y: 100,
  width: 80,
  height: 80,
  confidence: 0.9,
  ...over,
});

/* -------------------------------------------------------------------------- */
/* Frame sampling geometry                                                    */
/* -------------------------------------------------------------------------- */

describe('decodeDimensions', () => {
  it('fits the longest edge and keeps the aspect ratio', () => {
    expect(decodeDimensions({ width: 1920, height: 1080 }, 640)).toEqual({ width: 640, height: 360 });
    expect(decodeDimensions({ width: 1080, height: 1920 }, 640)).toEqual({ width: 360, height: 640 });
  });

  it('never upscales a source that is already small', () => {
    expect(decodeDimensions({ width: 320, height: 240 }, 640)).toEqual({ width: 320, height: 240 });
  });

  it('returns even dimensions, and rejects nonsense', () => {
    const fitted = decodeDimensions({ width: 1001, height: 667 }, 500)!;
    expect(fitted.width % 2).toBe(0);
    expect(fitted.height % 2).toBe(0);

    expect(decodeDimensions({ width: 0, height: 100 }, 640)).toBeNull();
    expect(decodeDimensions({ width: 100, height: 100 }, 0)).toBeNull();
  });
});

describe('buildSampleArgs', () => {
  const request: FrameSampleRequest = {
    videoPath: '/videos/talk.mp4',
    startSec: 12.5,
    endSec: 42.5,
    fps: 2,
    maxFrames: 60,
    maxEdgePx: 640,
  };

  it('seeks before the input and bounds the decode', () => {
    const args = buildSampleArgs(request, { width: 640, height: 360 }, 60);

    // Input seek, as in `buildCutArgs`: decoding to the start point is the slow way.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('12.5');
    expect(args[args.indexOf('-t') + 1]).toBe('30');

    // The two halves of "do not process every frame".
    expect(args[args.indexOf('-vf') + 1]).toBe('fps=2,scale=640:360:flags=bilinear');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('60');

    // Raw frames of a known size are what make the stream sliceable.
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('rgb24');
    expect(args[args.indexOf('-f') + 1]).toBe('rawvideo');
    expect(args.at(-1)).toBe('-');
  });
});

/* -------------------------------------------------------------------------- */
/* YuNet pre- and post-processing                                             */
/* -------------------------------------------------------------------------- */

describe('letterboxFrame', () => {
  it('pads to the square instead of stretching, and reports the mapping', () => {
    const frame = paintFrame(640, 360, () => [10, 20, 30]);
    const { input, box } = letterboxFrame(frame);

    expect(input).toHaveLength(3 * YUNET_INPUT_SIZE * YUNET_INPUT_SIZE);
    expect(box.scale).toBe(1);
    expect(box.padX).toBe(0);
    expect(box.padY).toBe(140); // (640 - 360) / 2

    const plane = YUNET_INPUT_SIZE * YUNET_INPUT_SIZE;
    const centre = (YUNET_INPUT_SIZE / 2) * YUNET_INPUT_SIZE + YUNET_INPUT_SIZE / 2;

    // BGR, and unnormalised: both are what the model was trained to expect.
    expect(input[centre]).toBe(30);
    expect(input[plane + centre]).toBe(20);
    expect(input[2 * plane + centre]).toBe(10);

    // The padding above the picture is black, not a smeared edge row.
    expect(input[0]).toBe(0);
    expect(input[plane]).toBe(0);
  });

  it('scales a frame larger than the input down to fit', () => {
    const { box } = letterboxFrame(paintFrame(1280, 720, () => [255, 255, 255]));
    expect(box.scale).toBeCloseTo(0.5, 6);
    expect(box.padY).toBe(140); // (640 - 720 × 0.5) / 2
  });
});

describe('decodeYuNet', () => {
  it('turns an anchor into the box the model means', () => {
    const outputs = yunetOutputs([
      { stride: 32, column: 10, row: 5, cls: 1, obj: 1, box: [0.5, 0.5, Math.log(3), Math.log(4)] },
    ]);

    const [box] = decodeYuNet(outputs);

    // centre = (cell + offset) * stride, size = exp(prediction) * stride
    expect(box!.x).toBeCloseTo((10 + 0.5) * 32 - (3 * 32) / 2, 4);
    expect(box!.y).toBeCloseTo((5 + 0.5) * 32 - (4 * 32) / 2, 4);
    expect(box!.width).toBeCloseTo(96, 4);
    expect(box!.height).toBeCloseTo(128, 4);
    expect(box!.confidence).toBeCloseTo(1, 6);
  });

  it('scores as the geometric mean of the two heads', () => {
    const outputs = yunetOutputs([
      { stride: 32, column: 4, row: 4, cls: 0.81, obj: 1, box: [0.5, 0.5, 0, 0] },
    ]);

    expect(decodeYuNet(outputs, { minConfidence: 0.1, iouThreshold: 0.3, maxDetections: 8 })[0]!.confidence)
      .toBeCloseTo(0.9, 6);
  });

  it('drops anchors below the confidence floor', () => {
    const outputs = yunetOutputs([
      { stride: 16, column: 8, row: 8, cls: 0.2, obj: 0.2, box: [0.5, 0.5, 0, 0] },
    ]);

    expect(decodeYuNet(outputs)).toHaveLength(0);
  });

  it('collapses the cluster a single face produces into one box', () => {
    // Four neighbouring cells all firing on the same large face.
    const outputs = yunetOutputs(
      [
        { column: 10, row: 5, cls: 0.99 },
        { column: 11, row: 5, cls: 0.95 },
        { column: 10, row: 6, cls: 0.92 },
        { column: 11, row: 6, cls: 0.9 },
      ].map(({ column, row, cls }) => ({
        stride: 32 as const,
        column,
        row,
        cls,
        obj: 1,
        box: [0.5, 0.5, Math.log(6), Math.log(6)] as const,
      })),
    );

    const boxes = decodeYuNet(outputs);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.confidence).toBeCloseTo(Math.sqrt(0.99), 4);
  });

  it('keeps two faces that are genuinely apart', () => {
    const outputs = yunetOutputs([
      { stride: 32, column: 3, row: 8, cls: 0.95, obj: 1, box: [0.5, 0.5, Math.log(2), Math.log(2)] },
      { stride: 32, column: 16, row: 8, cls: 0.9, obj: 1, box: [0.5, 0.5, Math.log(2), Math.log(2)] },
    ]);

    expect(decodeYuNet(outputs)).toHaveLength(2);
  });

  it('treats a tensor bag with missing heads as an empty frame', () => {
    expect(decodeYuNet({})).toHaveLength(0);
  });
});

describe('nonMaxSuppression', () => {
  it('does not depend on the order it is given', () => {
    const boxes: FrameDetection[] = [
      { x: 0, y: 0, width: 100, height: 100, confidence: 0.7 },
      { x: 5, y: 5, width: 100, height: 100, confidence: 0.9 },
      { x: 400, y: 0, width: 100, height: 100, confidence: 0.8 },
    ];

    const forwards = nonMaxSuppression(boxes, 0.3, 8);
    const backwards = nonMaxSuppression([...boxes].reverse(), 0.3, 8);

    expect(forwards).toEqual(backwards);
    expect(forwards.map((b) => b.confidence)).toEqual([0.9, 0.8]);
  });

  it('honours the output ceiling', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      x: i * 200,
      y: 0,
      width: 50,
      height: 50,
      confidence: 0.5,
    }));

    expect(nonMaxSuppression(many, 0.3, 3)).toHaveLength(3);
  });
});

describe('toFrameCoordinates', () => {
  const box = { scale: 0.5, padX: 0, padY: 140 };

  it('undoes the letterbox', () => {
    const mapped = toFrameCoordinates(
      { x: 100, y: 240, width: 50, height: 60, confidence: 0.8 },
      box,
      { width: 1280, height: 720 },
    )!;

    expect(mapped.x).toBeCloseTo(200, 6);
    expect(mapped.y).toBeCloseTo(200, 6);
    expect(mapped.width).toBeCloseTo(100, 6);
    expect(mapped.height).toBeCloseTo(120, 6);
    expect(mapped.confidence).toBe(0.8);
  });

  it('clips a box that hangs off the edge', () => {
    const mapped = toFrameCoordinates(
      { x: -40, y: 140, width: 100, height: 100, confidence: 0.8 },
      box,
      { width: 1280, height: 720 },
    )!;

    expect(mapped.x).toBe(0);
    expect(mapped.width).toBeCloseTo(120, 6);
  });

  it('rejects a box predicted entirely in the padding', () => {
    expect(
      toFrameCoordinates({ x: 10, y: 10, width: 20, height: 20, confidence: 0.9 }, box, {
        width: 1280,
        height: 720,
      }),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Luminance detector                                                         */
/* -------------------------------------------------------------------------- */

describe('detectLuminanceBlobs', () => {
  it('finds a lit subject against a dark set', () => {
    // Aligned to the 16 px detection grid, so the reported box is the subject
    // rather than the subject plus a quantisation margin.
    const subject = { x: 208, y: 64, width: 96, height: 160 };
    const frame = paintFrame(640, 360, (x, y) => (inside(x, y, subject) ? [250, 250, 250] : [12, 12, 14]));

    const [found, ...rest] = detectLuminanceBlobs(frame);

    expect(rest).toHaveLength(0);
    expect(found!.confidence).toBeGreaterThan(0.5);
    expect(found!.confidence).toBeLessThanOrEqual(1);
    expect(found).toMatchObject(subject);
  });

  it('separates two subjects instead of boxing them together', () => {
    const left = { x: 60, y: 80, width: 80, height: 140 };
    const right = { x: 440, y: 80, width: 80, height: 140 };
    const frame = paintFrame(640, 360, (x, y) =>
      inside(x, y, left) || inside(x, y, right) ? [240, 240, 240] : [10, 10, 10],
    );

    const found = detectLuminanceBlobs(frame);
    expect(found).toHaveLength(2);
    expect(Math.min(...found.map((f) => f.x))).toBeLessThan(200);
    expect(Math.max(...found.map((f) => f.x))).toBeGreaterThan(400);
  });

  it('finds nothing in a frame with nothing to find', () => {
    expect(detectLuminanceBlobs(paintFrame(320, 180, () => [128, 128, 128]))).toHaveLength(0);
  });

  it('refuses to call the whole frame a subject', () => {
    // Bright everywhere but one small dark corner: variation exists, but the
    // lit region is the scene.
    const frame = paintFrame(320, 180, (x, y) => (x < 20 && y < 20 ? [0, 0, 0] : [230, 230, 230]));
    expect(detectLuminanceBlobs(frame)).toHaveLength(0);
  });

  it('is deterministic', async () => {
    const frame = paintFrame(320, 180, (x, y) => (inside(x, y, { x: 100, y: 40, width: 60, height: 90 }) ? [255, 255, 255] : [5, 5, 5]));
    const detector = new LuminanceBlobDetector();

    expect(await detector.detect(frame)).toEqual(await detector.detect(frame));
    await detector.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Association                                                                */
/* -------------------------------------------------------------------------- */

describe('trackPrimarySubject', () => {
  /** Ten frames, half a second apart, each carrying the given boxes. */
  const script = (perFrame: readonly (readonly FrameDetection[])[]): DetectionFrame[] =>
    perFrame.map((detections, i) => ({ atSec: i * 0.5, detections }));

  const walking = (i: number): FrameDetection => detection({ x: 500 + i * 20, y: 300, width: 160, height: 200 });

  it('follows one subject across frames under one identity', () => {
    const frames = script(Array.from({ length: 10 }, (_, i) => [walking(i)]));
    const observations = trackPrimarySubject(frames, { source: SOURCE });

    expect(observations).toHaveLength(10);
    expect(new Set(observations.map((o) => o.subjectId)).size).toBe(1);
    expect(observations.every((o) => isUsableObservation(o, SOURCE))).toBe(true);
    expect(observations.map((o) => o.atSec)).toEqual([...observations.map((o) => o.atSec)].sort((a, b) => a - b));
  });

  it('returns nothing when there is nothing to track', () => {
    expect(trackPrimarySubject([], { source: SOURCE })).toEqual([]);
    expect(trackPrimarySubject(script([[], [], []]), { source: SOURCE })).toEqual([]);
  });

  it('ignores detections below the confidence floor', () => {
    const frames = script(Array.from({ length: 10 }, (_, i) => [{ ...walking(i), confidence: 0.2 }]));
    expect(trackPrimarySubject(frames, { source: SOURCE })).toEqual([]);
  });

  it('picks the more present of two people and stays on them', () => {
    // One person throughout; a second appears for two frames only.
    const host = detection({ x: 300, y: 300, width: 200, height: 240, confidence: 0.8 });
    const guest = detection({ x: 1400, y: 300, width: 200, height: 240, confidence: 0.99 });

    const frames = script(
      Array.from({ length: 10 }, (_, i) => (i === 4 || i === 5 ? [host, guest] : [host])),
    );

    const observations = trackPrimarySubject(frames, { source: SOURCE });
    const ids = new Set(observations.map((o) => o.subjectId));

    expect(ids.size).toBe(1);
    expect(observations).toHaveLength(10);
    // The host, not the briefly-more-confident guest.
    expect(observations.every((o) => o.x === 300)).toBe(true);
  });

  it('survives a frame or two of lost detection without changing identity', () => {
    const frames = script(
      Array.from({ length: 10 }, (_, i) => (i === 4 || i === 5 ? [] : [walking(i)])),
    );

    const observations = trackPrimarySubject(frames, { source: SOURCE });

    expect(observations).toHaveLength(8);
    expect(new Set(observations.map((o) => o.subjectId)).size).toBe(1);
  });

  it('treats a long absence as a different appearance', () => {
    // Gone for 2.5s, well past the 1.5s tolerance, then back.
    const frames = script(
      Array.from({ length: 12 }, (_, i) => (i >= 3 && i <= 7 ? [] : [walking(i)])),
    );

    const tracks = associateTracks(frames, { source: SOURCE });
    expect(tracks.length).toBeGreaterThan(1);
  });

  it('gives up when the best subject is too intermittent to follow', () => {
    // Present in 2 of 12 sampled frames: real, but not something to point a
    // camera at. The crop path is meant to centre-crop instead.
    const frames = script(Array.from({ length: 12 }, (_, i) => (i < 2 ? [walking(i)] : [])));

    expect(trackPrimarySubject(frames, { source: SOURCE })).toEqual([]);
  });

  it('does not merge two people who happen to be near each other', () => {
    const left = detection({ x: 400, y: 300, width: 180, height: 220 });
    const right = detection({ x: 700, y: 300, width: 180, height: 220 });
    const frames = script(Array.from({ length: 8 }, () => [left, right]));

    const tracks = associateTracks(frames, { source: SOURCE });
    expect(tracks).toHaveLength(2);
    expect(tracks.every((t) => t.observations.length === 8)).toBe(true);
  });

  it('refuses to continue a track onto a wildly different box', () => {
    // Same place, but ten times the area: a face box becoming a body box.
    const frames = script([
      [detection({ x: 500, y: 300, width: 100, height: 100 })],
      [detection({ x: 500, y: 300, width: 400, height: 400 })],
    ]);

    expect(associateTracks(frames, { source: SOURCE })).toHaveLength(2);
  });

  it('is stable when a subject walks in mid-clip', () => {
    const frames = script(
      Array.from({ length: 10 }, (_, i) => (i < 3 ? [] : [walking(i)])),
    );

    const observations = trackPrimarySubject(frames, { source: SOURCE });
    expect(observations).toHaveLength(7);
    expect(observations[0]!.atSec).toBe(1.5);
  });

  it('orders tracks by presence rather than by peak confidence', () => {
    const brief = detection({ x: 1400, y: 200, width: 300, height: 300, confidence: 1 });
    const constant = detection({ x: 300, y: 200, width: 300, height: 300, confidence: 0.6 });
    const frames = script(Array.from({ length: 10 }, (_, i) => (i === 0 ? [brief, constant] : [constant])));

    const tracks = associateTracks(frames, { source: SOURCE });
    expect(selectPrimaryTrack(tracks)!.observations).toHaveLength(10);
    expect(selectPrimaryTrack([])).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Windowed selection                                                         */
/* -------------------------------------------------------------------------- */

describe('trackPrimarySubjectWindowed', () => {
  const script = (perFrame: readonly (readonly FrameDetection[])[]): DetectionFrame[] =>
    perFrame.map((detections, i) => ({ atSec: i * 0.5, detections }));

  /** Two people, far enough apart that association never merges them. */
  const left = (over: Partial<FrameDetection> = {}) =>
    detection({ x: 200, y: 300, width: 200, height: 240, confidence: 0.9, ...over });
  const right = (over: Partial<FrameDetection> = {}) =>
    detection({ x: 1500, y: 300, width: 200, height: 240, confidence: 0.9, ...over });

  it('agrees with the whole-clip rule when there is only one subject', () => {
    const frames = script(
      Array.from({ length: 10 }, (_, i) => [detection({ x: 500 + i * 20, y: 300, width: 160, height: 200 })]),
    );

    expect(trackPrimarySubjectWindowed(frames, { source: SOURCE })).toEqual(
      trackPrimarySubject(frames, { source: SOURCE }),
    );
  });

  it('switches to the other person when they take over the second half', () => {
    // 24 frames = 12s. Left owns the first half alone, right the second half.
    const frames = script(Array.from({ length: 24 }, (_, i) => (i < 12 ? [left()] : [right()])));

    const observations = trackPrimarySubjectWindowed(frames, { source: SOURCE });
    const ids = new Set(observations.map((o) => o.subjectId));

    expect(ids.size).toBe(2);
    expect(observations[0]!.x).toBe(200);
    expect(observations[observations.length - 1]!.x).toBe(1500);
  });

  it('does not switch for a briefly louder challenger', () => {
    // Both present throughout; the right-hand person is momentarily bigger for a
    // single window, which is exactly what the sustain count exists to ignore.
    const frames = script(
      Array.from({ length: 24 }, (_, i) =>
        i === 10 || i === 11 ? [left(), right({ width: 400, height: 460 })] : [left(), right()],
      ),
    );

    const observations = trackPrimarySubjectWindowed(frames, { source: SOURCE });
    expect(new Set(observations.map((o) => o.subjectId)).size).toBe(1);
  });

  it('does not flap between two people of near-equal presence', () => {
    const frames = script(Array.from({ length: 24 }, () => [left(), right({ confidence: 0.88 })]));

    const observations = trackPrimarySubjectWindowed(frames, { source: SOURCE });
    expect(new Set(observations.map((o) => o.subjectId)).size).toBe(1);
  });

  it('follows whoever is left when the incumbent walks out', () => {
    // Left alone, then gone entirely; right arrives and stays. The incumbent has
    // no presence at all, so loyalty would frame an empty chair.
    const frames = script(Array.from({ length: 20 }, (_, i) => (i < 8 ? [left()] : [right()])));

    const observations = trackPrimarySubjectWindowed(frames, { source: SOURCE });
    expect(observations[observations.length - 1]!.x).toBe(1500);
  });

  it('still gives up when nobody is on screen long enough to follow', () => {
    const frames = script(Array.from({ length: 20 }, (_, i) => (i < 2 ? [left()] : i === 3 ? [right()] : [])));

    expect(trackPrimarySubjectWindowed(frames, { source: SOURCE })).toEqual([]);
  });

  it('returns observations in time order across a switch', () => {
    const frames = script(Array.from({ length: 24 }, (_, i) => (i < 12 ? [left()] : [right()])));

    const times = trackPrimarySubjectWindowed(frames, { source: SOURCE }).map((o) => o.atSec);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('is deterministic', () => {
    const frames = script(Array.from({ length: 24 }, (_, i) => (i < 12 ? [left()] : [right()])));

    expect(trackPrimarySubjectWindowed(frames, { source: SOURCE })).toEqual(
      trackPrimarySubjectWindowed(frames, { source: SOURCE }),
    );
  });

  it('returns nothing when there is nothing to track', () => {
    expect(trackPrimarySubjectWindowed([], { source: SOURCE })).toEqual([]);
    expect(trackPrimarySubjectWindowed(script([[], [], []]), { source: SOURCE })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The tracker itself                                                         */
/* -------------------------------------------------------------------------- */

describe('DetectorSubjectTracker', () => {
  const request = {
    videoPath: '/videos/talk.mp4',
    range: { startSec: 10, endSec: 20 },
    source: SOURCE,
  };

  it('scales detections from the decoded frame back into source pixels', async () => {
    const samples = Array.from({ length: 6 }, (_, i) => ({
      atSec: 10 + i * 0.5,
      frame: paintFrame(64, 36, () => [0, 0, 0]),
    }));

    // A box covering the middle quarter of a 64×36 frame.
    const boxes = samples.map(() => [detection({ x: 16, y: 9, width: 32, height: 18, confidence: 0.9 })]);

    const tracker = new DetectorSubjectTracker({
      detector: new ScriptedDetector(boxes),
      frames: new ScriptedFrameSource(samples),
    });

    const result = await tracker.track(request);

    expect(result.trackerId).toBe('detector:scripted');
    expect(result.observations).toHaveLength(6);

    const first = result.observations[0]!;
    expect(first.x).toBeCloseTo(480, 3);
    expect(first.y).toBeCloseTo(270, 3);
    expect(first.width).toBeCloseTo(960, 3);
    expect(first.height).toBeCloseTo(540, 3);

    // Everything the contract promises about an observation.
    for (const observation of result.observations) {
      expect(isUsableObservation(observation, SOURCE)).toBe(true);
      expect(observation.atSec).toBeGreaterThanOrEqual(request.range.startSec);
      expect(observation.atSec).toBeLessThanOrEqual(request.range.endSec);
      expect(observation.x + observation.width).toBeLessThanOrEqual(SOURCE.width);
      expect(observation.y + observation.height).toBeLessThanOrEqual(SOURCE.height);
      expect(observation.subjectId).not.toBeNull();
    }
  });

  it('bounds the decode before it starts', async () => {
    const source = new ScriptedFrameSource([]);
    const tracker = new DetectorSubjectTracker({
      detector: new ScriptedDetector([]),
      frames: source,
      fps: 2,
      maxFrames: 8,
      maxEdgePx: 480,
    });

    // 10 seconds at 2 fps would be 21 frames; the ceiling wins.
    await tracker.track(request);
    expect(source.requests[0]).toMatchObject({ fps: 2, maxFrames: 8, maxEdgePx: 480 });

    // A short range costs less than the ceiling rather than always the ceiling.
    await tracker.track({ ...request, range: { startSec: 0, endSec: 2 } });
    expect(source.requests[1]!.maxFrames).toBe(5);
  });

  it('lets the caller ask for a different observation spacing', async () => {
    const source = new ScriptedFrameSource([]);
    const tracker = new DetectorSubjectTracker({ detector: new ScriptedDetector([]), frames: source, fps: 2 });

    await tracker.track({ ...request, intervalSec: 0.25 });
    expect(source.requests[0]!.fps).toBe(4);
  });

  it('reports nothing rather than throwing when the detector fails', async () => {
    const tracker = new DetectorSubjectTracker({
      detector: new ThrowingDetector(),
      frames: new ScriptedFrameSource([blankSample(10)]),
    });

    await expect(tracker.track(request)).resolves.toEqual({
      observations: [],
      trackerId: 'detector:throwing',
    });
  });

  it('reports nothing rather than throwing when decoding fails', async () => {
    const tracker = new DetectorSubjectTracker({
      detector: new ScriptedDetector([]),
      frames: new ThrowingFrameSource(),
    });

    await expect(tracker.track(request)).resolves.toMatchObject({ observations: [] });
  });

  it('treats an empty or backwards range as nothing to do', async () => {
    const source = new ScriptedFrameSource([blankSample(0)]);
    const tracker = new DetectorSubjectTracker({ detector: new ScriptedDetector([]), frames: source });

    await expect(tracker.track({ ...request, range: { startSec: 20, endSec: 20 } })).resolves.toMatchObject({
      observations: [],
    });
    expect(source.requests).toHaveLength(0);
  });

  it('feeds the existing crop path a tracked plan', async () => {
    const samples = Array.from({ length: 12 }, (_, i) => ({ atSec: 10 + i * 0.5, frame: paintFrame(64, 36, () => [0, 0, 0]) }));
    // A subject crossing the frame, so the resulting path has to move.
    const boxes = samples.map((_, i) => [detection({ x: 4 + i * 4, y: 8, width: 12, height: 20, confidence: 0.9 })]);

    const tracker = new DetectorSubjectTracker({
      detector: new ScriptedDetector(boxes),
      frames: new ScriptedFrameSource(samples),
    });

    const result = await tracker.track(request);
    const plan = buildCropPath(result.observations, {
      source: SOURCE,
      range: request.range,
      trackerId: result.trackerId,
    });

    expect(plan.strategy).toBe('tracked');
    // Keyframes come out clip-relative, so the range they are checked against is.
    expect(isCropPlanValid(plan, { startSec: 0, endSec: 10 })).toBe(true);
    expect(plan.keyframes.every((kf) => cropWindowFits(kf, SOURCE))).toBe(true);
    expect(plan.rationale).toContain('detector:scripted');

    const xs = plan.keyframes.map((kf) => kf.x);
    expect(xs.at(-1)!).toBeGreaterThan(xs[0]!);
  });

  it('falls back to a centre crop when the detector found nothing', () => {
    const plan = buildCropPath([], { source: SOURCE, range: request.range, trackerId: 'detector:scripted' });

    expect(plan.strategy).toBe('static');
    expect(plan.keyframes[0]!.confidence).toBe(0);
    expect(plan.rationale).toContain('no confident subject');
  });
});

describe('toSourceCoordinates', () => {
  it('clips a subject leaving the frame instead of reporting a box outside it', () => {
    const mapped = toSourceCoordinates(
      { x: 50, y: -5, width: 30, height: 20, confidence: 0.7 },
      { width: 64, height: 36 },
      SOURCE,
    )!;

    expect(mapped.x + mapped.width).toBe(SOURCE.width);
    expect(mapped.y).toBe(0);
  });

  it('rejects a box with no area inside the frame', () => {
    expect(
      toSourceCoordinates({ x: 70, y: 0, width: 10, height: 10, confidence: 0.7 }, { width: 64, height: 36 }, SOURCE),
    ).toBeNull();
    expect(toSourceCoordinates(detection(), { width: 0, height: 36 }, SOURCE)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

describe('createSubjectTracker', () => {
  const frames = new ScriptedFrameSource([]);

  it('defaults to the deterministic tracker, which needs nothing installed', async () => {
    const selected = await createSubjectTracker({ mode: 'center' });

    expect(selected.tracker).toBeInstanceOf(CenterSubjectTracker);
    expect(selected.mode).toBe('center');
    expect(selected.detector).toBeNull();
  });

  it('can be turned off entirely', async () => {
    const selected = await createSubjectTracker({ mode: 'none' });
    expect(selected.tracker).toBeInstanceOf(NullSubjectTracker);
  });

  it('selects the luminance detector without any model', async () => {
    const selected = await createSubjectTracker({ mode: 'luminance', frames });

    expect(selected.mode).toBe('luminance');
    expect(selected.tracker).toBeInstanceOf(DetectorSubjectTracker);
    expect(selected.detector).toBeInstanceOf(LuminanceBlobDetector);
  });

  it('degrades to the centre tracker when a detector cannot run', async () => {
    const noFrames = await createSubjectTracker({ mode: 'face', modelPath: '/models/yunet.onnx' });
    expect(noFrames.mode).toBe('center');
    expect(noFrames.requested).toBe('face');
    expect(noFrames.reason).toMatch(/frame source/i);

    const noPath = await createSubjectTracker({ mode: 'face', frames });
    expect(noPath.mode).toBe('center');
    expect(noPath.reason).toMatch(/model path/i);

    const missing = await createSubjectTracker({
      mode: 'face',
      frames,
      modelPath: path.join(os.tmpdir(), 'definitely-not-a-model.onnx'),
    });
    expect(missing.mode).toBe('center');
    expect(missing.reason).toMatch(/not found/i);
    expect(missing.tracker).toBeInstanceOf(CenterSubjectTracker);
  });

  it('selects the face detector once the weights are present', async () => {
    // The selector checks that a file is there; it does not load it, which is
    // what lets this run with a stand-in.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-model-'));
    const modelPath = path.join(dir, 'face_detection_yunet_2023mar.onnx');
    await fsp.writeFile(modelPath, 'not really a model');

    try {
      const selected = await createSubjectTracker({ mode: 'face', frames, modelPath });

      if (isInstalled('onnxruntime-node')) {
        expect(selected.mode).toBe('face');
        expect(selected.tracker).toBeInstanceOf(DetectorSubjectTracker);
        expect(selected.detector?.id).toBe('yunet');
      } else {
        expect(selected.mode).toBe('center');
        expect(selected.reason).toMatch(/onnxruntime-node/);
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('knows whether an optional package is installed without importing it', () => {
    expect(isInstalled('vitest')).toBe(true);
    expect(isInstalled('a-package-that-does-not-exist-anywhere')).toBe(false);
  });
});
