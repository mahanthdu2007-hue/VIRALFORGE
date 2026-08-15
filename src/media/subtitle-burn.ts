/**
 * Subtitle burn-in, expressed as a `RenderProfile`.
 *
 * The counterpart to `reframe.ts`: the ASS document is produced by the subtitle
 * engine, written to a file by the pipeline, and folded into the render here as
 * one more video filter. Neither `buildCutArgs` nor `FfmpegClipRenderer` learns
 * that subtitles exist.
 *
 * The one decision this module makes is **where in the chain the captions go**,
 * and it is not cosmetic. `videoFilterChain` appends `profile.scale` last, so a
 * naive append would order the chain crop → subtitles → scale: captions burned
 * onto the crop window's native pixels (which for a 1080p source is roughly
 * 594×1056) and then upscaled to 1080×1920 along with them, which is exactly
 * how you get soft, fringed text over a sharp picture. So the pending scale is
 * materialised as an explicit filter *first* and the burn-in appended after it:
 * crop → scale → subtitles. The captions are then rasterised by libass directly
 * at output resolution, at the size the layout computed for that frame.
 *
 * Everything here is pure: a profile in, a profile out. No file is written and
 * no process is spawned — the caller owns the `.ass` file's lifetime.
 */

import { subtitlesFilter } from '@/subtitles';
import type { RenderProfile } from './clip-render';

/**
 * Burn the captions in `assPath` onto whatever the profile already produces.
 *
 * @param assPath absolute path to a written ASS document. It must still exist
 *        when FFmpeg runs — libass reads it during the encode, not before.
 */
export function withBurnedSubtitles(profile: RenderProfile, assPath: string): RenderProfile {
  const scaled: RenderProfile = profile.scale
    ? {
        ...profile,
        videoFilters: [...profile.videoFilters, `scale=${profile.scale.width}:${profile.scale.height}`],
        // Consumed: leaving it set would append a second, redundant scale after
        // the burn-in and resample the captions we just placed.
        scale: null,
      }
    : profile;

  return { ...scaled, videoFilters: [...scaled.videoFilters, subtitlesFilter(assPath)] };
}
