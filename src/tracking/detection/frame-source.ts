/**
 * Where frames come from — the port, not the decoder.
 *
 * The tracking layer deliberately knows nothing about FFmpeg (see
 * `tracking/index.ts`), but a real detector obviously needs pixels. `FrameSource`
 * is how it asks for them without acquiring that dependency: the media layer
 * supplies the FFmpeg adapter, tests supply an array.
 *
 * Two properties of this interface matter more than they look:
 *
 *  - **It yields, it does not return.** A minute of video at any useful
 *    resolution is hundreds of megabytes of raw RGB. An async iterable lets the
 *    consumer detect on frame *n* while frame *n+1* is still being decoded, and
 *    lets an implementation hold exactly one frame in memory. A `Promise<Frame[]>`
 *    would make bounded memory impossible to express.
 *  - **Sampling is requested, not assumed.** `fps` and `maxFrames` are inputs
 *    rather than an implementation detail, because "do not decode every frame"
 *    is a correctness property of this feature, not an optimisation.
 */

import type { RgbFrame } from './types';

export interface FrameSampleRequest {
  /** Absolute path to the source video. Opened read-only. */
  readonly videoPath: string;
  readonly startSec: number;
  readonly endSec: number;
  /** Frames to sample per second of source. Fractional values are allowed. */
  readonly fps: number;
  /**
   * Hard ceiling on frames yielded, whatever `fps` and the range imply. The
   * bound on this feature's cost, and the reason a long range cannot turn into
   * an unbounded decode.
   */
  readonly maxFrames: number;
  /**
   * Longest edge of the decoded frame, in pixels. Frames are downscaled to fit,
   * preserving aspect ratio; they are never upscaled.
   */
  readonly maxEdgePx: number;
}

/** One sampled frame and where it sits on the **source** timeline. */
export interface SampledFrame {
  readonly atSec: number;
  readonly frame: RgbFrame;
}

export interface FrameSource {
  readonly id: string;
  /**
   * Sample frames across the requested range, in ascending time order.
   *
   * The consumer may stop early; an implementation must treat abandonment of
   * the iterator as a signal to tear down whatever it started.
   */
  frames(request: FrameSampleRequest): AsyncIterable<SampledFrame>;
}

/**
 * Decode size for a source, fitted inside `maxEdgePx` and rounded to even
 * dimensions.
 *
 * Even matters: `rgb24` has no chroma subsampling so odd sizes are legal, but
 * the swscale/encoder paths downstream are happier with even ones, and rounding
 * here rather than letting `scale=-2` decide means the frame's byte length is
 * known before FFmpeg is started — which is what makes the stream parseable.
 */
export function decodeDimensions(
  source: { readonly width: number; readonly height: number },
  maxEdgePx: number,
): { readonly width: number; readonly height: number } | null {
  if (!(source.width > 0) || !(source.height > 0) || !(maxEdgePx > 0)) return null;

  const longest = Math.max(source.width, source.height);
  // Never upscale: inventing pixels cannot help a detector and costs time.
  const scale = Math.min(1, maxEdgePx / longest);

  const width = evenAtLeastTwo(source.width * scale);
  const height = evenAtLeastTwo(source.height * scale);
  return { width, height };
}

const evenAtLeastTwo = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
