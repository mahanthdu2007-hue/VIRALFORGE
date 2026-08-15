import type { Brand, IsoTimestamp } from './common';

export type VideoId = Brand<string, 'VideoId'>;

/**
 * Technical facts read off a media file by the media engine (ffprobe).
 * Absent until the file has been probed.
 */
export interface MediaMetadata {
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  /** Frames per second, already reduced from ffprobe's rational form. */
  readonly fps: number;
  readonly hasAudio: boolean;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  /** Total container bitrate in bits/sec, when the container reports one. */
  readonly bitrate: number | null;
  readonly containerFormat: string;
}

/**
 * An uploaded source video. The bytes themselves always stay on disk and are
 * referenced by `storageKey`; nothing in the system holds a whole video in RAM.
 */
export interface VideoAsset {
  readonly id: VideoId;
  readonly originalFilename: string;
  /** Path relative to the configured storage root. */
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly createdAt: IsoTimestamp;
  /** Populated by the ANALYZING stage. */
  readonly metadata: MediaMetadata | null;
}

/** Aspect ratio of the Shorts output. Fixed for now; kept as a type for clarity. */
export const SHORTS_ASPECT_RATIO = 9 / 16;
export const SHORTS_OUTPUT_WIDTH = 1080;
export const SHORTS_OUTPUT_HEIGHT = 1920;
