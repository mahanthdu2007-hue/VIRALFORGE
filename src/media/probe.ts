/**
 * ffprobe output → `MediaMetadata`.
 *
 * Parsing is a pure function over already-decoded JSON so it can be unit-tested
 * without invoking ffprobe.
 */

import { mediaError } from '@/lib/errors';
import type { MediaMetadata } from '@/domain';

/** Only the fields we consume; ffprobe emits far more. */
export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
}

export interface ProbeOutput {
  streams?: ProbeStream[];
  format?: {
    duration?: string;
    bit_rate?: string;
    format_name?: string;
  };
}

/** Converts ffprobe's `"30000/1001"` rational into 29.97. */
export function parseFrameRate(rational: string | undefined): number | null {
  if (!rational) return null;
  const [numText, denText = '1'] = rational.split('/');
  const num = Number(numText);
  const den = Number(denText);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) return null;
  return Math.round((num / den) * 1000) / 1000;
}

/**
 * @throws AppError kind=media when the file has no usable video stream or
 *         no duration — both mean we cannot plan clips from it.
 */
export function parseProbeOutput(output: ProbeOutput): MediaMetadata {
  const streams = output.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  if (!video) {
    throw mediaError('no_video_stream', 'The file contains no video stream.');
  }

  const durationSec = Number(output.format?.duration ?? video.duration ?? NaN);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw mediaError('unknown_duration', 'Could not determine the video duration.');
  }

  const width = Number(video.width ?? 0);
  const height = Number(video.height ?? 0);
  if (width <= 0 || height <= 0) {
    throw mediaError('unknown_resolution', 'Could not determine the video resolution.');
  }

  const fps = parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate);
  if (fps === null) {
    throw mediaError('unknown_frame_rate', 'Could not determine the video frame rate.');
  }

  const bitrate = Number(output.format?.bit_rate ?? NaN);

  return {
    durationSec: Math.round(durationSec * 1000) / 1000,
    width,
    height,
    fps,
    hasAudio: audio !== undefined,
    videoCodec: video.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null,
    containerFormat: output.format?.format_name ?? 'unknown',
  };
}
