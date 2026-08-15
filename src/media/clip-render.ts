/**
 * FFmpeg command construction for clip rendering.
 *
 * Everything in this file is **pure**: it builds argument lists and parses
 * probe output, and never touches the filesystem or spawns a process. That is
 * what makes the exact command an assertion in a unit test rather than
 * something you discover from a broken render.
 *
 * Two decisions live here and are worth stating plainly:
 *
 *  1. **When stream copy is safe.** Copying packets is enormously faster than
 *     re-encoding, but `-ss` on a copied stream cannot land anywhere except a
 *     keyframe — FFmpeg silently moves the cut to the preceding one. A plan
 *     says 42.187s because that is where the sentence starts, so a cut that
 *     drifts to 40.0s is simply the wrong clip. Copy is therefore allowed only
 *     when the requested start *already is* a keyframe; otherwise we re-encode.
 *
 *  2. **How later phases extend this.** `RenderProfile` carries a filter chain
 *     and an optional output size. 9:16 reframing appends a crop/scale filter,
 *     subtitles append a burn-in filter, and neither needs to touch the
 *     argument builders. A profile that asks for any filtering disables stream
 *     copy automatically, because you cannot filter packets you are copying.
 */

import type { ClipCut } from '@/domain';

/** How a cut is transferred from source to output. */
export type RenderMode =
  /** Packets copied verbatim. Fastest, and bit-exact, but keyframe-bound. */
  | 'stream_copy'
  /** Decoded and re-encoded. Frame-accurate at any timestamp. */
  | 'reencode';

/**
 * Encoder settings and the filter chain applied to a render.
 *
 * Held as data rather than baked into the builders so that a later phase can
 * supply a different profile without this module changing.
 */
export interface RenderProfile {
  readonly videoCodec: string;
  readonly audioCodec: string;
  /** x264 quality: lower is better. 18 is visually transparent for Shorts. */
  readonly crf: number;
  readonly preset: string;
  readonly audioBitrate: string;
  /** Audio sample rate, or null to keep the source's. */
  readonly audioSampleRateHz: number | null;
  readonly pixelFormat: string;
  /**
   * Video filters, applied in order. Empty in this phase.
   * 9:16 reframing and subtitle burn-in append to this list.
   */
  readonly videoFilters: readonly string[];
  /** Forced output resolution, or null to keep the source's. */
  readonly scale: { readonly width: number; readonly height: number } | null;
  /** Move the MP4 index to the front so the file starts playing before it is fully fetched. */
  readonly faststart: boolean;
}

/**
 * Preserve the source as faithfully as a re-encode allows.
 *
 * No filters and no forced resolution: this phase cuts, it does not reframe.
 * AAC at 192k is transparent for speech, and the source sample rate is kept so
 * the audio timeline is not resampled underneath the video.
 */
export const DEFAULT_RENDER_PROFILE: RenderProfile = {
  videoCodec: 'libx264',
  audioCodec: 'aac',
  crf: 18,
  preset: 'veryfast',
  audioBitrate: '192k',
  audioSampleRateHz: null,
  pixelFormat: 'yuv420p',
  videoFilters: [],
  scale: null,
  faststart: true,
};

/** Codecs that can be copied into an MP4 without remuxing trouble. */
const COPYABLE_VIDEO_CODECS = new Set(['h264', 'hevc', 'h265']);
const COPYABLE_AUDIO_CODECS = new Set(['aac', 'mp3']);

/**
 * How close to a keyframe a start must be to count as landing on it.
 *
 * One frame at 60fps is ~16ms; 20ms keeps a genuine keyframe hit while
 * refusing a start that is merely nearby.
 */
export const KEYFRAME_EPSILON_SEC = 0.02;

/* -------------------------------------------------------------------------- */
/* Argument construction                                                      */
/* -------------------------------------------------------------------------- */

/** Flags every invocation needs: no stdin, no banner, errors only on stderr. */
const BASE_FLAGS = ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error'] as const;

export interface CutArgsInput {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly cut: Pick<ClipCut, 'startSec' | 'endSec'>;
  readonly mode: RenderMode;
  readonly profile?: RenderProfile;
}

/**
 * Build the command that extracts one cut.
 *
 * `-ss` goes **before** `-i` so FFmpeg seeks the container instead of decoding
 * and discarding from zero — the difference between instant and minutes on a
 * long source. Since FFmpeg 2.1 that seek is still frame-accurate when
 * re-encoding, and `-accurate_seek` states the requirement rather than relying
 * on it being the default.
 *
 * `-t` rather than `-to`, because after an input seek `-to` is interpreted
 * against the *source* timeline on some builds; a duration is unambiguous.
 */
export function buildCutArgs(input: CutArgsInput): string[] {
  const profile = input.profile ?? DEFAULT_RENDER_PROFILE;
  const durationSec = input.cut.endSec - input.cut.startSec;

  const args: string[] = [
    ...BASE_FLAGS,
    '-accurate_seek',
    '-ss',
    formatSeconds(input.cut.startSec),
    '-i',
    input.sourcePath,
    '-t',
    formatSeconds(durationSec),
    // First video stream, and the first audio stream if the source has one.
    // The `?` keeps a silent source renderable instead of failing the map.
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    // Subtitle and data streams are dropped: they are a later phase's job and
    // an unmapped data stream can fail the mux outright.
    '-sn',
    '-dn',
  ];

  if (input.mode === 'stream_copy') {
    args.push('-c', 'copy');
  } else {
    const filters = videoFilterChain(profile);
    if (filters) args.push('-vf', filters);

    args.push(
      '-c:v',
      profile.videoCodec,
      '-preset',
      profile.preset,
      '-crf',
      String(profile.crf),
      '-pix_fmt',
      profile.pixelFormat,
      '-c:a',
      profile.audioCodec,
      '-b:a',
      profile.audioBitrate,
    );

    if (profile.audioSampleRateHz !== null) args.push('-ar', String(profile.audioSampleRateHz));
  }

  args.push(...timingFlags(), ...containerFlags(profile), input.outputPath);
  return args;
}

export interface ConcatArgsInput {
  readonly listPath: string;
  readonly outputPath: string;
  readonly profile?: RenderProfile;
}

/**
 * Build the command that joins already-rendered segments.
 *
 * The concat *demuxer* (not the filter) is used deliberately: it works on
 * whole files and copies packets, so joining never re-encodes what the cut
 * stage just encoded. Every segment came out of `buildCutArgs` with identical
 * settings, which is the demuxer's precondition.
 */
export function buildConcatArgs(input: ConcatArgsInput): string[] {
  const profile = input.profile ?? DEFAULT_RENDER_PROFILE;

  return [
    ...BASE_FLAGS,
    '-f',
    'concat',
    // The list references files by absolute path, which the demuxer refuses
    // unless unsafe paths are explicitly permitted.
    '-safe',
    '0',
    '-i',
    input.listPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    ...timingFlags(),
    ...containerFlags(profile),
    input.outputPath,
  ];
}

/**
 * Timestamp hygiene, applied to every output.
 *
 * An input seek can leave the first packet with a negative timestamp, which
 * players interpret as a leading gap — audio that starts before its video.
 * `make_zero` rebases the clip to start at zero, and `-muxpreload`/`-muxdelay`
 * at 0 stop the MP4 muxer reintroducing an offset of its own. Together these
 * are what keep A/V in sync across a cut.
 */
const timingFlags = (): string[] => [
  '-avoid_negative_ts',
  'make_zero',
  '-muxpreload',
  '0',
  '-muxdelay',
  '0',
];

const containerFlags = (profile: RenderProfile): string[] => [
  ...(profile.faststart ? ['-movflags', '+faststart'] : []),
  '-f',
  'mp4',
];

/** The `-vf` value for a profile, or null when nothing is being filtered. */
export function videoFilterChain(profile: RenderProfile): string | null {
  const filters = [...profile.videoFilters];

  if (profile.scale) {
    filters.push(`scale=${profile.scale.width}:${profile.scale.height}`);
  }

  return filters.length > 0 ? filters.join(',') : null;
}

/**
 * The concat demuxer's list file.
 *
 * Single quotes are the demuxer's own escaping, and a literal quote inside a
 * path is escaped as `'\''` — the same rule as a POSIX shell, despite no shell
 * being involved.
 */
export const buildConcatListFile = (segmentPaths: readonly string[]): string =>
  `${segmentPaths.map((p) => `file '${p.split("'").join("'\\''")}'`).join('\n')}\n`;

/* -------------------------------------------------------------------------- */
/* Keyframe inspection                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build the ffprobe command listing video keyframe timestamps near `atSec`.
 *
 * Packets rather than frames: a packet's `K` flag identifies a keyframe without
 * decoding anything, and `-read_intervals` bounds the scan to a window around
 * the point of interest instead of walking the whole file.
 */
export function buildKeyframeProbeArgs(sourcePath: string, atSec: number, windowSec = 2): string[] {
  const from = Math.max(0, atSec - windowSec);
  const to = atSec + windowSec;

  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time,flags',
    '-read_intervals',
    `${formatSeconds(from)}%${formatSeconds(to)}`,
    '-print_format',
    'json',
    sourcePath,
  ];
}

interface ProbePacket {
  pts_time?: string;
  flags?: string;
}

/** Keyframe timestamps from `buildKeyframeProbeArgs` output. Never throws. */
export function parseKeyframeTimes(stdout: string): number[] {
  let parsed: { packets?: ProbePacket[] };
  try {
    parsed = JSON.parse(stdout) as { packets?: ProbePacket[] };
  } catch {
    // An unreadable probe is not an error: it only means we cannot prove a
    // keyframe is there, and the caller falls back to re-encoding.
    return [];
  }

  return (parsed.packets ?? [])
    .filter((packet) => packet.flags?.includes('K'))
    .map((packet) => Number(packet.pts_time))
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);
}

/** Whether any keyframe sits within `epsilon` of `atSec`. */
export const hasKeyframeAt = (
  keyframeTimes: readonly number[],
  atSec: number,
  epsilon = KEYFRAME_EPSILON_SEC,
): boolean => keyframeTimes.some((time) => Math.abs(time - atSec) <= epsilon);

export interface StreamCopyCheck {
  readonly cuts: readonly Pick<ClipCut, 'startSec' | 'endSec'>[];
  readonly profile: RenderProfile;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  /** Keyframe timestamps near each cut start, one list per cut, in order. */
  readonly keyframeTimesPerCut: readonly (readonly number[])[];
}

export interface StreamCopyVerdict {
  readonly mode: RenderMode;
  /** Machine-readable explanation, e.g. `start_not_on_keyframe`. */
  readonly reason: string;
}

/**
 * Decide between copying packets and re-encoding.
 *
 * Deliberately conservative: every condition must hold, and anything unknown
 * (a codec ffprobe did not name, a keyframe list we could not read) counts as
 * a reason to re-encode. Being wrong here produces a clip that starts in the
 * wrong place, which is far more expensive than the encode we avoided.
 */
export function decideRenderMode(check: StreamCopyCheck): StreamCopyVerdict {
  if (videoFilterChain(check.profile) !== null) {
    return { mode: 'reencode', reason: 'filters_requested' };
  }

  if (!check.videoCodec || !COPYABLE_VIDEO_CODECS.has(check.videoCodec)) {
    return { mode: 'reencode', reason: 'video_codec_not_copyable' };
  }

  // A source with no audio is copyable; a source with audio we cannot copy is not.
  if (check.audioCodec !== null && !COPYABLE_AUDIO_CODECS.has(check.audioCodec)) {
    return { mode: 'reencode', reason: 'audio_codec_not_copyable' };
  }

  for (const [index, cut] of check.cuts.entries()) {
    const keyframes = check.keyframeTimesPerCut[index] ?? [];
    if (!hasKeyframeAt(keyframes, cut.startSec)) {
      return { mode: 'reencode', reason: 'start_not_on_keyframe' };
    }
  }

  return { mode: 'stream_copy', reason: 'copy_safe' };
}

/* -------------------------------------------------------------------------- */

/**
 * Seconds as a plain decimal.
 *
 * `String(0.0000001)` is `"1e-7"`, which FFmpeg parses as 1 second. Fixing the
 * precision at microseconds removes the exponent and is finer than any frame
 * rate we will meet.
 */
export function formatSeconds(seconds: number): string {
  const fixed = seconds.toFixed(6);
  // Trim trailing zeros so the arguments read as written: "12.5", not "12.500000".
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') || '0' : fixed;
}
