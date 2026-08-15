/**
 * Discovery over a long video, one window at a time.
 *
 * One request for a whole transcript asks the model to do something it is bad
 * at: hold forty minutes of speech in mind and return the twelve best moments
 * in it. What comes back is twelve moments drawn overwhelmingly from wherever
 * the model's attention happened to settle — in practice the opening minutes —
 * and a 32-minute source ends up with roughly one candidate per three minutes
 * for ranking to choose from. That is far too thin a pool to find three good
 * Shorts, and no amount of scoring downstream can recover a moment that was
 * never proposed.
 *
 * So the transcript is cut into overlapping windows and each is asked
 * separately, with its own full candidate budget. A 32-minute source becomes
 * four requests and forty-odd candidates, each chosen against ten minutes of
 * context rather than forty.
 *
 * Three properties this module exists to guarantee:
 *
 *  1. **Short videos are untouched.** A source that fits in one window takes
 *     exactly the path it always did — one request, same arguments. Windowing
 *     changes the candidate pool, and the pool decides the output, so it may not
 *     change anything for the sources that were already working.
 *  2. **Windows overlap, so a moment on a seam is still seen whole.** A beat
 *     straddling the boundary would otherwise be cut in half and proposed by
 *     neither side. The overlap is wider than the longest candidate for exactly
 *     that reason.
 *  3. **The seam is invisible downstream.** Overlap means the same moment is
 *     genuinely proposed twice, so merging deduplicates on time and text before
 *     anything else sees the result. Ranking's own duplicate rules stay where
 *     they are, doing their own job on a pool that no longer arrives pre-spoiled.
 *
 * Requests are issued one at a time, deliberately: this runs on a 16 GB laptop
 * against a rate-limited API, and four concurrent generations would risk both.
 */

import type { CandidateClipDraft, ClipDiscoveryCapability, ClipDiscoveryRequest } from '@/ai/types';
import { overlapRatio } from '@/clips/ranking';
import { textSimilarity } from '@/clips/text';
import type { Logger } from '@/lib/logger';

export interface WindowedDiscoveryOptions {
  /** Speech per window. Ten minutes is a comfortable read for the model. */
  readonly windowSec?: number;
  /**
   * How much consecutive windows share. Must exceed the longest candidate a
   * window may return, or a moment on the seam is proposed whole by neither.
   */
  readonly overlapSec?: number;
  /** Above this ratio two drafts are the same moment seen from two windows. */
  readonly duplicateOverlapRatio?: number;
  /** Text overlap that makes two drafts duplicates regardless of their times. */
  readonly duplicateTextSimilarity?: number;
  readonly logger?: Pick<Logger, 'debug' | 'info' | 'warn'>;
}

export const WINDOWED_DISCOVERY_DEFAULTS = {
  windowSec: 600,
  overlapSec: 90,
  duplicateOverlapRatio: 0.5,
  duplicateTextSimilarity: 0.6,
} as const;

/**
 * Discover across the whole transcript, windowing only when it is long enough
 * to need it.
 *
 * Returns drafts in source order. Never throws for a window that fails: a
 * request that errors costs that window's candidates and the rest still ship,
 * because losing ten minutes of a source is better than losing the run. A total
 * failure is rethrown, since that is indistinguishable from discovery being
 * broken and should not look like "this video had no good moments".
 */
export async function discoverAcrossWindows(
  discovery: ClipDiscoveryCapability,
  request: ClipDiscoveryRequest,
  options: WindowedDiscoveryOptions = {},
): Promise<readonly CandidateClipDraft[]> {
  const settings = { ...WINDOWED_DISCOVERY_DEFAULTS, ...definedOnly(options) };
  const windows = planWindows(request, settings.windowSec, settings.overlapSec);

  // The short-video path, and the reason it is an early return rather than a
  // loop of one: it must be provably the same call it was before windowing.
  if (windows.length <= 1) return discovery.discoverClips(request);

  options.logger?.info('discovery windowed across a long transcript', {
    windows: windows.length,
    windowSec: settings.windowSec,
    overlapSec: settings.overlapSec,
    videoDurationSec: Math.round(request.videoDurationSec),
  });

  const collected: CandidateClipDraft[] = [];
  let failures = 0;

  for (const [index, window] of windows.entries()) {
    const segments = request.segments.filter((s) => s.endSec > window.startSec && s.startSec < window.endSec);
    if (segments.length === 0) continue;

    try {
      // `videoDurationSec` stays the whole video: the segments carry absolute
      // timestamps, and telling the model the source is ten minutes long while
      // handing it times at minute thirty invites it to "correct" them.
      const drafts = await discovery.discoverClips({ ...request, segments });
      collected.push(...drafts);

      options.logger?.debug('discovery window complete', {
        window: index + 1,
        of: windows.length,
        rangeSec: [Math.round(window.startSec), Math.round(window.endSec)],
        segments: segments.length,
        drafts: drafts.length,
      });
    } catch (error) {
      failures += 1;
      options.logger?.warn('discovery window failed; continuing with the others', {
        window: index + 1,
        of: windows.length,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures === windows.length) {
    throw new Error(`Discovery failed for all ${windows.length} transcript windows.`);
  }

  const merged = mergeDrafts(collected, settings.duplicateOverlapRatio, settings.duplicateTextSimilarity);
  options.logger?.info('discovery windows merged', {
    windows: windows.length,
    collected: collected.length,
    merged: merged.length,
    duplicatesDropped: collected.length - merged.length,
  });

  return merged;
}

/* -------------------------------------------------------------------------- */

export interface DiscoveryWindow {
  readonly startSec: number;
  readonly endSec: number;
}

/**
 * The windows a transcript is read in.
 *
 * Returns a single window covering everything when the source is short enough
 * to be read at once, which is what keeps the one-request path exact. The last
 * window always ends at the source's end rather than at a stride boundary, so
 * no tail is left unread.
 */
export function planWindows(
  request: Pick<ClipDiscoveryRequest, 'segments' | 'videoDurationSec'>,
  windowSec: number,
  overlapSec: number,
): readonly DiscoveryWindow[] {
  const spoken = request.segments.reduce((max, s) => Math.max(max, s.endSec), 0);
  const endSec = Math.max(spoken, request.videoDurationSec);
  if (!(endSec > 0) || !(windowSec > 0)) return [{ startSec: 0, endSec: Math.max(endSec, 0) }];
  if (endSec <= windowSec) return [{ startSec: 0, endSec }];

  // A stride that does not advance would loop forever; the guard matters more
  // than it looks because overlap is a caller-supplied number.
  const stride = Math.max(windowSec - Math.max(0, overlapSec), windowSec / 2);
  const windows: DiscoveryWindow[] = [];

  for (let start = 0; start < endSec; start += stride) {
    windows.push({ startSec: start, endSec: Math.min(start + windowSec, endSec) });
    if (start + windowSec >= endSec) break;
  }

  return windows;
}

/**
 * Concatenated window results → one pool, in source order, without the seams.
 *
 * Earlier drafts win a tie, which given source ordering means the window that
 * saw a moment with more context ahead of it keeps its version. Comparison is
 * against everything already kept rather than only the previous draft, because
 * three windows can all touch one moment where the overlap is generous.
 */
export function mergeDrafts(
  drafts: readonly CandidateClipDraft[],
  duplicateOverlapRatio: number,
  duplicateTextSimilarity: number,
): readonly CandidateClipDraft[] {
  const ordered = [...drafts].sort(
    (a, b) => a.startSec - b.startSec || a.endSec - b.endSec || (b.confidence ?? 0) - (a.confidence ?? 0),
  );

  const kept: CandidateClipDraft[] = [];

  for (const draft of ordered) {
    const duplicate = kept.some((existing) => isSameDraft(existing, draft, duplicateOverlapRatio, duplicateTextSimilarity));
    if (!duplicate) kept.push(draft);
  }

  return kept;
}

/**
 * Two drafts describing one moment.
 *
 * An identical hook quote is decisive on its own: the quote is verbatim
 * transcript, so the same one twice means two windows found the same line, at
 * whatever boundaries each happened to choose. Otherwise it takes either a real
 * overlap in time or a close description of the same subject.
 */
function isSameDraft(
  a: CandidateClipDraft,
  b: CandidateClipDraft,
  duplicateOverlapRatio: number,
  duplicateTextSimilarity: number,
): boolean {
  const quote = normalise(a.hookQuote);
  if (quote.length > 0 && quote === normalise(b.hookQuote)) return true;
  if (overlapRatio(a, b) > duplicateOverlapRatio) return true;

  // Similar wording alone is not enough — two windows can legitimately propose
  // different moments on the same topic — so it must also be the same stretch.
  return (
    overlapRatio(a, b) > 0 &&
    textSimilarity(describe(a), describe(b)) > duplicateTextSimilarity
  );
}

const describe = (draft: CandidateClipDraft): string => `${draft.hookQuote ?? ''} ${draft.topic ?? ''}`;

const normalise = (value: string | null): string =>
  (value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const definedOnly = <T extends object>(source: T): Partial<T> =>
  Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as Partial<T>;
