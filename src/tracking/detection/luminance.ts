/**
 * A detector with no model behind it.
 *
 * It finds connected regions that are markedly brighter than the rest of the
 * frame and calls each one a subject. That is a real measurement over real
 * pixels — not a stub — but it is a *saliency* heuristic, not recognition: it
 * has no idea what a person is, and on an evenly-lit two-shot it will find the
 * window behind the speakers as readily as the speakers.
 *
 * It exists for two honest reasons. It is the only detector that needs neither
 * a native runtime nor downloaded weights, which makes it the one that can
 * drive a real end-to-end test — video in, boxes out, crop plan, render — on any
 * machine, in a normal `vitest run`. And on high-contrast footage (a lit subject
 * against a dark set) it is genuinely better than a fixed centre crop.
 *
 * For real framing decisions, use the face detector. This is the fallback below
 * it, not an alternative to it.
 */

import type { FrameDetection, FrameDetector, RgbFrame } from './types';

export interface LuminanceBlobDetectorOptions {
  /** Cells across the frame's longest edge. Coarser is faster and less noisy. */
  readonly gridSize?: number;
  /** Standard deviations above the mean a cell must be to count as lit. */
  readonly thresholdSigma?: number;
  /** Regions covering less of the frame than this are noise. */
  readonly minAreaFraction?: number;
  /**
   * Regions covering more than this are the scene, not a subject — a
   * uniformly bright frame must produce nothing rather than one box around
   * everything.
   */
  readonly maxAreaFraction?: number;
  readonly minConfidence?: number;
  readonly maxDetections?: number;
}

const DEFAULTS = {
  gridSize: 40,
  thresholdSigma: 1.1,
  minAreaFraction: 0.004,
  maxAreaFraction: 0.6,
  minConfidence: 0.35,
  maxDetections: 6,
} as const;

export class LuminanceBlobDetector implements FrameDetector {
  readonly id = 'luminance';

  constructor(private readonly options: LuminanceBlobDetectorOptions = {}) {}

  async detect(frame: RgbFrame): Promise<readonly FrameDetection[]> {
    return detectLuminanceBlobs(frame, this.options);
  }

  async close(): Promise<void> {
    // Nothing is held open; the method exists so the interface stays uniform.
  }
}

/**
 * The detector as a pure function — same frame, same boxes, every time.
 *
 * Works on a coarse grid of cell averages rather than on pixels. Averaging is
 * the noise rejection (a single hot pixel cannot become a subject), the grid is
 * what makes connected-component labelling cheap, and both together keep the
 * cost proportional to the frame rather than to the number of bright things in
 * it.
 */
export function detectLuminanceBlobs(
  frame: RgbFrame,
  options: LuminanceBlobDetectorOptions = {},
): readonly FrameDetection[] {
  const settings = { ...DEFAULTS, ...definedOnly(options) };
  const longest = Math.max(frame.width, frame.height);
  if (!(longest > 0) || frame.data.length < frame.width * frame.height * 3) return [];

  const cellSize = Math.max(1, Math.floor(longest / settings.gridSize));
  const columns = Math.max(1, Math.ceil(frame.width / cellSize));
  const rows = Math.max(1, Math.ceil(frame.height / cellSize));

  const cells = cellLuminance(frame, cellSize, columns, rows);
  const stats = describe(cells);
  const threshold = stats.mean + settings.thresholdSigma * stats.deviation;

  // A frame with no variation has no salient anything. Without this guard the
  // threshold sits at the mean and half the frame lights up.
  if (!(stats.max > stats.mean) || !(stats.deviation > 1)) return [];

  const lit = Array.from(cells, (value) => value >= threshold);
  const labels = labelComponents(lit, cells, columns, rows);

  const frameArea = frame.width * frame.height;
  const detections: FrameDetection[] = [];

  for (const region of labels) {
    const x = region.minColumn * cellSize;
    const y = region.minRow * cellSize;
    const width = Math.min(frame.width, (region.maxColumn + 1) * cellSize) - x;
    const height = Math.min(frame.height, (region.maxRow + 1) * cellSize) - y;
    if (!(width > 0) || !(height > 0)) continue;

    const areaFraction = (width * height) / frameArea;
    if (areaFraction < settings.minAreaFraction || areaFraction > settings.maxAreaFraction) continue;

    const mean = region.total / region.count;
    const confidence = clamp01((mean - stats.mean) / Math.max(1, stats.max - stats.mean));
    if (confidence < settings.minConfidence) continue;

    detections.push({ x, y, width, height, confidence: round4(confidence) });
  }

  return detections
    .sort((a, b) => b.confidence - a.confidence || b.width * b.height - a.width * a.height || a.x - b.x)
    .slice(0, settings.maxDetections);
}

/* -------------------------------------------------------------------------- */

/** Mean Rec. 601 luma per grid cell, row-major. */
function cellLuminance(frame: RgbFrame, cellSize: number, columns: number, rows: number): Float64Array {
  const totals = new Float64Array(columns * rows);
  const counts = new Float64Array(columns * rows);

  for (let y = 0; y < frame.height; y += 1) {
    const cellRow = Math.min(rows - 1, Math.floor(y / cellSize));
    const rowOffset = y * frame.width * 3;

    for (let x = 0; x < frame.width; x += 1) {
      const i = rowOffset + x * 3;
      const luma = 0.299 * frame.data[i]! + 0.587 * frame.data[i + 1]! + 0.114 * frame.data[i + 2]!;
      const cell = cellRow * columns + Math.min(columns - 1, Math.floor(x / cellSize));
      totals[cell]! += luma;
      counts[cell]! += 1;
    }
  }

  return totals.map((total, i) => (counts[i]! > 0 ? total / counts[i]! : 0));
}

interface Region {
  readonly minColumn: number;
  readonly maxColumn: number;
  readonly minRow: number;
  readonly maxRow: number;
  /** Summed cell luma, for the region's mean brightness. */
  readonly total: number;
  readonly count: number;
}

/**
 * Four-connected components over the lit cells, by flood fill.
 *
 * Four rather than eight on purpose: diagonal connectivity happily bridges two
 * separate speakers through one bright cell between them, and merging two
 * subjects into one box is a worse failure than splitting one.
 */
function labelComponents(
  lit: readonly boolean[],
  cells: Float64Array,
  columns: number,
  rows: number,
): readonly Region[] {
  const seen = new Uint8Array(columns * rows);
  const regions: Region[] = [];

  for (let start = 0; start < lit.length; start += 1) {
    if (!lit[start] || seen[start]) continue;

    let minColumn = columns;
    let maxColumn = -1;
    let minRow = rows;
    let maxRow = -1;
    let count = 0;
    let total = 0;

    const stack = [start];
    seen[start] = 1;

    const push = (next: number): void => {
      if (lit[next] && !seen[next]) {
        seen[next] = 1;
        stack.push(next);
      }
    };

    while (stack.length > 0) {
      const index = stack.pop()!;
      const column = index % columns;
      const row = (index - column) / columns;

      minColumn = Math.min(minColumn, column);
      maxColumn = Math.max(maxColumn, column);
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
      total += cells[index]!;
      count += 1;

      if (column > 0) push(index - 1);
      if (column < columns - 1) push(index + 1);
      if (row > 0) push(index - columns);
      if (row < rows - 1) push(index + columns);
    }

    regions.push({ minColumn, maxColumn, minRow, maxRow, total, count });
  }

  return regions;
}

function describe(values: Float64Array): { mean: number; deviation: number; max: number } {
  if (values.length === 0) return { mean: 0, deviation: 0, max: 0 };

  let sum = 0;
  let max = -Infinity;
  for (const value of values) {
    sum += value;
    if (value > max) max = value;
  }

  const mean = sum / values.length;
  let variance = 0;
  for (const value of values) variance += (value - mean) ** 2;

  return { mean, deviation: Math.sqrt(variance / values.length), max };
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;

/** Spread-safe: an explicit `undefined` must not overwrite a default. */
const definedOnly = <T extends object>(source: T): Partial<T> =>
  Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as Partial<T>;
