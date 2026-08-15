/**
 * The frame-level half of subject tracking.
 *
 * `SubjectTracker` answers "where is the subject over this range?". Answering it
 * for real splits into three jobs that have nothing to do with each other:
 * getting pixels out of a video, finding boxes in one still image, and deciding
 * which box is *the* subject across time. This module names the seam between the
 * first two.
 *
 * A `FrameDetector` sees one decoded frame and nothing else — no video path, no
 * timeline, no notion of a previous frame. That is what makes the ONNX face
 * detector, the luminance blob detector and a hand-written test double
 * interchangeable, and what lets the association logic be a pure function over
 * their output rather than something entangled with inference.
 */

/** One decoded frame, 8-bit RGB, row-major, three bytes per pixel, no padding. */
export interface RgbFrame {
  readonly width: number;
  readonly height: number;
  /** Length is exactly `width * height * 3`. */
  readonly data: Uint8Array;
}

/** A box a detector believes contains a subject, in that frame's pixels. */
export interface FrameDetection {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 0..1. Comparable within one detector; not across detectors. */
  readonly confidence: number;
}

export interface FrameDetector {
  readonly id: string;
  /**
   * Find subjects in one frame.
   *
   * Returning an empty list is the normal way to say "nothing here"; throwing
   * is reserved for a detector that is genuinely broken (no model, corrupt
   * weights), because the caller treats a throw as "this detector is unusable"
   * rather than "this frame was empty".
   */
  detect(frame: RgbFrame): Promise<readonly FrameDetection[]>;
  /** Release native resources. Safe to call more than once. */
  close(): Promise<void>;
}

/** Frames of detections on the source timeline, ascending by `atSec`. */
export interface DetectionFrame {
  readonly atSec: number;
  readonly detections: readonly FrameDetection[];
}

/** Bytes one `RgbFrame` of these dimensions occupies. */
export const frameByteLength = (width: number, height: number): number => width * height * 3;

/** Intersection-over-union of two boxes. 0 when they do not overlap. */
export function iou(a: FrameDetection, b: FrameDetection): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (overlap <= 0) return 0;

  const union = a.width * a.height + b.width * b.height - overlap;
  return union > 0 ? overlap / union : 0;
}
