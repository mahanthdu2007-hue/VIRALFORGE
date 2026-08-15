/**
 * YuNet's tensors in, boxes out — with no reference to ONNX Runtime.
 *
 * Everything a face detector gets wrong is in here rather than in the module
 * that runs the model: the anchor arithmetic, the score combination, the
 * letterbox that has to be inverted exactly, and the suppression that turns a
 * cloud of near-identical boxes into one face. Keeping it pure means all of it
 * can be tested from hand-written arrays, with no model file, no native binary
 * and no video — which is the difference between "the detector is covered" and
 * "the detector is covered on a machine that downloaded 232 KB of weights".
 *
 * The model is `face_detection_yunet_2023mar.onnx` from OpenCV's model zoo. It
 * is anchor-free and single-shot: three feature maps at strides 8, 16 and 32
 * over a fixed 640×640 input, each cell predicting one box as an offset from
 * its own position. `README` documents how to obtain it.
 */

import { iou, type FrameDetection, type RgbFrame } from './types';

/** The exported graph has a static input shape; this is not a tunable. */
export const YUNET_INPUT_SIZE = 640;
export const YUNET_STRIDES = [8, 16, 32] as const;

/** The tensor bag `InferenceSession.run` returns, reduced to what decoding needs. */
export type YuNetOutputs = Readonly<Record<string, ArrayLike<number>>>;

export interface YuNetDecodeOptions {
  /** Detections scoring below this are dropped before suppression. */
  readonly minConfidence: number;
  /** Boxes overlapping a stronger box by more than this are suppressed. */
  readonly iouThreshold: number;
  /** Ceiling on boxes returned, strongest first. */
  readonly maxDetections: number;
}

export const YUNET_DECODE_DEFAULTS: YuNetDecodeOptions = {
  minConfidence: 0.6,
  iouThreshold: 0.3,
  maxDetections: 8,
};

/** How a frame was fitted into the model's square input. */
export interface Letterbox {
  /** Multiply frame pixels by this to get input pixels. */
  readonly scale: number;
  readonly padX: number;
  readonly padY: number;
}

/**
 * Fit a frame into a 640×640 NCHW **BGR** float tensor.
 *
 * Two details are load-bearing. The channel order is BGR because the model was
 * trained through OpenCV, which reads images that way; feeding RGB does not
 * fail, it just detects noticeably worse, which is the sort of bug that never
 * gets found. And the values are raw 0..255 — YuNet has its normalisation baked
 * in, so dividing by 255 here would quietly halve the detection rate.
 *
 * Aspect ratio is preserved by padding rather than stretched to the square: a
 * squashed face is a face the model has not seen. Sampling is nearest-neighbour,
 * which costs nothing and matters little because the caller has already asked
 * the decoder for frames at roughly this size.
 */
export function letterboxFrame(frame: RgbFrame, size = YUNET_INPUT_SIZE): {
  readonly input: Float32Array;
  readonly box: Letterbox;
} {
  const scale = Math.min(size / frame.width, size / frame.height);
  const fittedWidth = Math.max(1, Math.round(frame.width * scale));
  const fittedHeight = Math.max(1, Math.round(frame.height * scale));
  const padX = Math.floor((size - fittedWidth) / 2);
  const padY = Math.floor((size - fittedHeight) / 2);

  const plane = size * size;
  // Zero-filled, so the padding is black and needs no separate pass.
  const input = new Float32Array(3 * plane);

  for (let y = 0; y < fittedHeight; y += 1) {
    const sourceY = Math.min(frame.height - 1, Math.floor(y / scale));
    const sourceRow = sourceY * frame.width * 3;
    const targetRow = (y + padY) * size + padX;

    for (let x = 0; x < fittedWidth; x += 1) {
      const sourceX = Math.min(frame.width - 1, Math.floor(x / scale));
      const s = sourceRow + sourceX * 3;
      const t = targetRow + x;

      input[t] = frame.data[s + 2]!; // B
      input[plane + t] = frame.data[s + 1]!; // G
      input[2 * plane + t] = frame.data[s]!; // R
    }
  }

  return { input, box: { scale, padX, padY } };
}

/**
 * Anchors and logits → boxes in input-square pixels, suppressed and sorted.
 *
 * Each cell of each feature map predicts a centre offset (in cells) and a
 * log-scale size, so a box is recovered as `(cell + offset) * stride` and
 * `exp(size) * stride`. The score is the geometric mean of the classification
 * and objectness heads — the model's own convention, and not interchangeable
 * with either head alone.
 */
export function decodeYuNet(
  outputs: YuNetOutputs,
  options: YuNetDecodeOptions = YUNET_DECODE_DEFAULTS,
  size = YUNET_INPUT_SIZE,
): readonly FrameDetection[] {
  const candidates: FrameDetection[] = [];

  for (const stride of YUNET_STRIDES) {
    const cls = outputs[`cls_${stride}`];
    const obj = outputs[`obj_${stride}`];
    const bbox = outputs[`bbox_${stride}`];
    // A missing head is a different model, not an empty frame.
    if (!cls || !obj || !bbox) continue;

    const columns = Math.round(size / stride);

    for (let i = 0; i < cls.length; i += 1) {
      const confidence = combineScores(cls[i]!, obj[i]!);
      if (confidence < options.minConfidence) continue;

      const column = i % columns;
      const row = Math.floor(i / columns);
      const centreX = (column + bbox[i * 4]!) * stride;
      const centreY = (row + bbox[i * 4 + 1]!) * stride;
      const width = Math.exp(bbox[i * 4 + 2]!) * stride;
      const height = Math.exp(bbox[i * 4 + 3]!) * stride;

      if (!(width > 0) || !(height > 0) || !Number.isFinite(centreX) || !Number.isFinite(centreY)) continue;

      candidates.push({
        x: centreX - width / 2,
        y: centreY - height / 2,
        width,
        height,
        confidence,
      });
    }
  }

  return nonMaxSuppression(candidates, options.iouThreshold, options.maxDetections);
}

/**
 * Keep the strongest box of each overlapping cluster.
 *
 * A single-shot detector fires on every cell near a face, so a clear face
 * arrives as a dozen boxes a few pixels apart. Without this the tracker would
 * see one person as a crowd, and "which subject is primary" would be decided by
 * whichever duplicate happened to sort first.
 */
export function nonMaxSuppression(
  detections: readonly FrameDetection[],
  iouThreshold: number,
  maxDetections: number,
): readonly FrameDetection[] {
  // Ties broken by geometry so the result does not depend on input order.
  const ordered = [...detections].sort(
    (a, b) => b.confidence - a.confidence || a.x - b.x || a.y - b.y || b.width - a.width,
  );

  const kept: FrameDetection[] = [];
  for (const candidate of ordered) {
    if (kept.length >= maxDetections) break;
    if (kept.some((other) => iou(candidate, other) > iouThreshold)) continue;
    kept.push(candidate);
  }

  return kept;
}

/**
 * Undo the letterbox and clip the box to the frame.
 *
 * Returns null for a box that ends up with no area inside the frame — a face
 * predicted entirely in the padding is an artefact, not a subject at the edge.
 */
export function toFrameCoordinates(
  detection: FrameDetection,
  box: Letterbox,
  frame: { readonly width: number; readonly height: number },
): FrameDetection | null {
  if (!(box.scale > 0)) return null;

  const left = (detection.x - box.padX) / box.scale;
  const top = (detection.y - box.padY) / box.scale;
  const right = left + detection.width / box.scale;
  const bottom = top + detection.height / box.scale;

  const clippedLeft = Math.max(0, left);
  const clippedTop = Math.max(0, top);
  const clippedRight = Math.min(frame.width, right);
  const clippedBottom = Math.min(frame.height, bottom);

  const width = clippedRight - clippedLeft;
  const height = clippedBottom - clippedTop;
  if (!(width > 0) || !(height > 0)) return null;

  return {
    x: clippedLeft,
    y: clippedTop,
    width,
    height,
    confidence: detection.confidence,
  };
}

/** Geometric mean of the two heads, each clamped to a probability first. */
const combineScores = (cls: number, obj: number): number => {
  const a = clamp01(cls);
  const b = clamp01(obj);
  return Math.sqrt(a * b);
};

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
