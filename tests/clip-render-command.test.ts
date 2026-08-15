import { describe, expect, it } from 'vitest';
import {
  buildConcatArgs,
  buildConcatListFile,
  buildCutArgs,
  buildKeyframeProbeArgs,
  decideRenderMode,
  formatSeconds,
  hasKeyframeAt,
  parseKeyframeTimes,
  videoFilterChain,
  DEFAULT_RENDER_PROFILE,
  type RenderProfile,
} from '@/media/clip-render';

const cut = { startSec: 42.187, endSec: 77.5 };

const joined = (args: readonly string[]) => args.join(' ');

describe('formatSeconds', () => {
  it('writes a plain decimal, never scientific notation', () => {
    // String(1e-7) is "1e-7", which FFmpeg reads as 1 second.
    expect(formatSeconds(0.0000001)).not.toMatch(/e/i);
  });

  it('keeps sub-millisecond precision', () => {
    expect(formatSeconds(42.187)).toBe('42.187');
    expect(formatSeconds(0.001)).toBe('0.001');
  });

  it('trims trailing zeros', () => {
    expect(formatSeconds(12.5)).toBe('12.5');
    expect(formatSeconds(30)).toBe('30');
  });

  it('formats zero as zero', () => {
    expect(formatSeconds(0)).toBe('0');
  });
});

describe('buildCutArgs', () => {
  it('seeks before the input and bounds the output by duration', () => {
    const args = buildCutArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', cut, mode: 'reencode' });

    // -ss must precede -i: seeking the container, not decoding from zero.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(joined(args)).toContain('-ss 42.187');
    expect(joined(args)).toContain('-t 35.313');
    expect(joined(args)).toContain('-accurate_seek');
  });

  it('maps the first video stream and an optional audio stream', () => {
    const args = joined(buildCutArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', cut, mode: 'reencode' }));

    expect(args).toContain('-map 0:v:0');
    // The `?` keeps a silent source renderable rather than failing the map.
    expect(args).toContain('-map 0:a:0?');
  });

  it('copies packets in stream_copy mode and encodes nothing', () => {
    const args = joined(buildCutArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', cut, mode: 'stream_copy' }));

    expect(args).toContain('-c copy');
    expect(args).not.toContain('-c:v libx264');
    expect(args).not.toContain('-crf');
  });

  it('applies controlled encoder settings in reencode mode', () => {
    const args = joined(buildCutArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', cut, mode: 'reencode' }));

    expect(args).toContain('-c:v libx264');
    expect(args).toContain('-crf 18');
    expect(args).toContain('-pix_fmt yuv420p');
    expect(args).toContain('-c:a aac');
    expect(args).toContain('-b:a 192k');
  });

  it('normalises timestamps so audio and video start together', () => {
    const args = joined(buildCutArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', cut, mode: 'reencode' }));

    expect(args).toContain('-avoid_negative_ts make_zero');
    expect(args).toContain('-muxpreload 0');
    expect(args).toContain('-muxdelay 0');
  });

  it('drops subtitle and data streams', () => {
    const args = buildCutArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', cut, mode: 'reencode' });
    expect(args).toContain('-sn');
    expect(args).toContain('-dn');
  });

  it('writes the output path last and names the source only as an input', () => {
    const args = buildCutArgs({
      sourcePath: '/videos/source.mp4',
      outputPath: '/renders/clip.mp4',
      cut,
      mode: 'reencode',
    });

    expect(args.at(-1)).toBe('/renders/clip.mp4');
    // The source appears exactly once — as the input, never as an output.
    expect(args.filter((a) => a === '/videos/source.mp4')).toHaveLength(1);
    expect(args[args.indexOf('/videos/source.mp4') - 1]).toBe('-i');
  });

  it('quietens FFmpeg so stderr carries the error, not the banner', () => {
    const args = joined(buildCutArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', cut, mode: 'reencode' }));

    expect(args).toContain('-hide_banner');
    expect(args).toContain('-loglevel error');
    expect(args).toContain('-nostdin');
  });

  it('appends a profile’s video filters, which later phases supply', () => {
    const profile: RenderProfile = {
      ...DEFAULT_RENDER_PROFILE,
      videoFilters: ['crop=608:1080:656:0'],
      scale: { width: 1080, height: 1920 },
    };

    const args = joined(buildCutArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', cut, mode: 'reencode', profile }));
    expect(args).toContain('-vf crop=608:1080:656:0,scale=1080:1920');
  });

  it('emits no -vf at all for the default, unfiltered profile', () => {
    expect(buildCutArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', cut, mode: 'reencode' })).not.toContain('-vf');
  });

  it('requests a faststart MP4', () => {
    const args = joined(buildCutArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', cut, mode: 'reencode' }));
    expect(args).toContain('-movflags +faststart');
    expect(args).toContain('-f mp4');
  });
});

describe('videoFilterChain', () => {
  it('is null when nothing is being filtered', () => {
    expect(videoFilterChain(DEFAULT_RENDER_PROFILE)).toBeNull();
  });

  it('joins filters in order, with scale last', () => {
    expect(
      videoFilterChain({
        ...DEFAULT_RENDER_PROFILE,
        videoFilters: ['crop=608:1080:656:0', 'subtitles=subs.ass'],
        scale: { width: 1080, height: 1920 },
      }),
    ).toBe('crop=608:1080:656:0,subtitles=subs.ass,scale=1080:1920');
  });
});

describe('buildConcatArgs', () => {
  it('uses the concat demuxer and copies packets rather than re-encoding', () => {
    const args = joined(buildConcatArgs({ listPath: 'list.txt', outputPath: 'out.mp4' }));

    expect(args).toContain('-f concat');
    expect(args).toContain('-safe 0');
    expect(args).toContain('-c copy');
  });

  it('writes the output path last', () => {
    expect(buildConcatArgs({ listPath: 'list.txt', outputPath: '/renders/out.mp4' }).at(-1)).toBe(
      '/renders/out.mp4',
    );
  });
});

describe('buildConcatListFile', () => {
  it('lists each segment as a quoted file directive', () => {
    expect(buildConcatListFile(['/tmp/a.mp4', '/tmp/b.mp4'])).toBe("file '/tmp/a.mp4'\nfile '/tmp/b.mp4'\n");
  });

  it('escapes a quote inside a path', () => {
    expect(buildConcatListFile(["/tmp/o'brien.mp4"])).toBe("file '/tmp/o'\\''brien.mp4'\n");
  });
});

describe('buildKeyframeProbeArgs', () => {
  it('reads packet flags on the first video stream only', () => {
    const args = joined(buildKeyframeProbeArgs('in.mp4', 42));

    expect(args).toContain('-select_streams v:0');
    expect(args).toContain('-show_entries packet=pts_time,flags');
    expect(args).toContain('-print_format json');
  });

  it('bounds the scan to a window around the requested point', () => {
    expect(joined(buildKeyframeProbeArgs('in.mp4', 42, 2))).toContain('-read_intervals 40%44');
  });

  it('never asks for a negative interval start', () => {
    expect(joined(buildKeyframeProbeArgs('in.mp4', 1, 2))).toContain('-read_intervals 0%3');
  });
});

describe('parseKeyframeTimes', () => {
  const output = JSON.stringify({
    packets: [
      { pts_time: '40.000000', flags: 'K__' },
      { pts_time: '40.500000', flags: '___' },
      { pts_time: '42.187000', flags: 'K__' },
    ],
  });

  it('returns only keyframe timestamps, sorted', () => {
    expect(parseKeyframeTimes(output)).toEqual([40, 42.187]);
  });

  it('returns an empty list for unparseable output rather than throwing', () => {
    expect(parseKeyframeTimes('not json')).toEqual([]);
    expect(parseKeyframeTimes('')).toEqual([]);
  });

  it('ignores packets with no usable timestamp', () => {
    expect(parseKeyframeTimes(JSON.stringify({ packets: [{ flags: 'K__' }] }))).toEqual([]);
  });
});

describe('hasKeyframeAt', () => {
  it('accepts an exact hit', () => {
    expect(hasKeyframeAt([40, 42.187], 42.187)).toBe(true);
  });

  it('accepts a hit inside the epsilon', () => {
    expect(hasKeyframeAt([42.19], 42.187)).toBe(true);
  });

  it('rejects a keyframe merely nearby', () => {
    expect(hasKeyframeAt([40, 44], 42.187)).toBe(false);
  });

  it('rejects when no keyframes are known', () => {
    expect(hasKeyframeAt([], 42.187)).toBe(false);
  });
});

describe('decideRenderMode', () => {
  const copyable = {
    cuts: [cut],
    profile: DEFAULT_RENDER_PROFILE,
    videoCodec: 'h264',
    audioCodec: 'aac',
    keyframeTimesPerCut: [[42.187]],
  };

  it('copies when the start is a keyframe and nothing is filtered', () => {
    expect(decideRenderMode(copyable)).toEqual({ mode: 'stream_copy', reason: 'copy_safe' });
  });

  it('re-encodes when the start is not on a keyframe', () => {
    // The whole point: a copied cut would silently drift to 40.0s.
    expect(decideRenderMode({ ...copyable, keyframeTimesPerCut: [[40]] })).toEqual({
      mode: 'reencode',
      reason: 'start_not_on_keyframe',
    });
  });

  it('re-encodes when the profile asks for any filtering', () => {
    expect(
      decideRenderMode({
        ...copyable,
        profile: { ...DEFAULT_RENDER_PROFILE, videoFilters: ['crop=608:1080:656:0'] },
      }).reason,
    ).toBe('filters_requested');
  });

  it('re-encodes when the profile forces a resolution', () => {
    expect(
      decideRenderMode({
        ...copyable,
        profile: { ...DEFAULT_RENDER_PROFILE, scale: { width: 1080, height: 1920 } },
      }).mode,
    ).toBe('reencode');
  });

  it.each([['vp9'], ['prores'], [null]])('re-encodes an uncopyable video codec: %s', (codec) => {
    expect(decideRenderMode({ ...copyable, videoCodec: codec }).reason).toBe('video_codec_not_copyable');
  });

  it('re-encodes an uncopyable audio codec', () => {
    expect(decideRenderMode({ ...copyable, audioCodec: 'pcm_s16le' }).reason).toBe('audio_codec_not_copyable');
  });

  it('still copies a source that has no audio at all', () => {
    expect(decideRenderMode({ ...copyable, audioCodec: null }).mode).toBe('stream_copy');
  });

  it('requires every cut to start on a keyframe', () => {
    expect(
      decideRenderMode({
        ...copyable,
        cuts: [cut, { startSec: 100, endSec: 110 }],
        keyframeTimesPerCut: [[42.187], [99]],
      }).reason,
    ).toBe('start_not_on_keyframe');
  });

  it('re-encodes when keyframes could not be read', () => {
    expect(decideRenderMode({ ...copyable, keyframeTimesPerCut: [[]] }).mode).toBe('reencode');
  });
});
