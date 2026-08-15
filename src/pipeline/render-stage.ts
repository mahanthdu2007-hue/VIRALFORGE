/**
 * The render stage: selected `ClipPlan`s → files on disk.
 *
 * The last stage of an analysis run, and the only one that produces something a
 * person can watch. It owns *orchestration only* — for each selected clip it
 * resolves the source, asks the subtitle engine for cues, calls the existing
 * `renderClipPlan` composition (tracking → crop → profile → FFmpeg), and
 * records the outcome. No geometry, no scoring, no chunking is decided here.
 *
 * Four properties this module exists to guarantee:
 *
 *  1. **Sequential, never concurrent.** Three 1080×1920 encodes at once on a
 *     16 GB machine contend for the same cores, the same disk and a great deal
 *     of memory, and finish no sooner than one after another. The loop is a
 *     plain `for…of` with an `await` in it, and that is deliberate.
 *  2. **One bad clip does not cost the good ones.** Every clip is rendered and
 *     recorded independently; a failure becomes a FAILED row carrying its
 *     reason and the loop moves on. The stage itself only throws if the *store*
 *     cannot be written, because then there is nothing left to report with.
 *  3. **Captions are the transcript's words or nothing.** The plan comes from
 *     `buildSubtitlePlan`, which reads the transcript alone, and is then put
 *     through `verifySubtitleFidelity` against the clip's own verbatim text.
 *     Cues that fail are not repaired and not burned — the clip renders without
 *     captions instead, because burning text the speaker did not say is the one
 *     outcome worse than burning none.
 *  4. **Nothing is left behind.** The renderer stages into its own temporary
 *     directory and `renderClipPlan` removes the ASS document it wrote; a
 *     failed clip leaves no partial file at its output path.
 */

import path from 'node:path';
import {
  verifySubtitleFidelity,
  type ClipPlan,
  type ClipRender,
  type IdFactory,
  type SubtitlePlan,
  type Transcript,
  type VideoAsset,
} from '@/domain';
import { toAppError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { buildSubtitlePlan } from '@/subtitles';
import { buildClipRender, type ClipRenderRepository } from '@/storage/clip-render-repository';
import type { FileStore } from '@/storage/file-store';
import type { RenderClipPlanRequest, RenderClipPlanResult } from './render-clip';

/**
 * Hard ceiling on clips rendered in one run.
 *
 * Selection already returns three, so this never binds in practice — it is here
 * so a change to ranking cannot silently turn one job into an hour of encoding.
 */
export const MAX_RENDERED_CLIPS = 3;

/** Renders one plan. Injected so the stage never constructs an FFmpeg command. */
export type RenderClipFn = (request: RenderClipPlanRequest) => Promise<RenderClipPlanResult>;

export interface RenderStageDeps {
  readonly logger: Logger;
  readonly files: FileStore;
  readonly renders: ClipRenderRepository;
  readonly renderClip: RenderClipFn;
  /** Injectable so tests can assert on stable identifiers. */
  readonly newId?: IdFactory;
  /** Defaults to `MAX_RENDERED_CLIPS`. */
  readonly maxRenderedClips?: number;
}

export interface RenderStageInput {
  /** The source, carrying its probed metadata. Read-only throughout. */
  readonly video: VideoAsset;
  /** Where the cue text comes from. Never rewritten. */
  readonly transcript: Transcript;
  /** The selected Shorts, best first. */
  readonly plans: readonly ClipPlan[];
  /** Called after each clip, with how many are done. Drives job progress. */
  readonly onProgress?: (done: number, total: number) => Promise<void> | void;
}

/**
 * Render every selected clip, in order, and record what happened to each.
 *
 * Returns one `ClipRender` per attempted clip — successes and failures in the
 * order they were rendered. Never throws for a render failure.
 */
export async function renderSelectedClips(
  deps: RenderStageDeps,
  input: RenderStageInput,
): Promise<readonly ClipRender[]> {
  const limit = deps.maxRenderedClips ?? MAX_RENDERED_CLIPS;
  const plans = input.plans.slice(0, Math.max(0, limit));
  const sourcePath = deps.files.absolutePath(input.video.storageKey);
  const records: ClipRender[] = [];

  for (const [index, plan] of plans.entries()) {
    const log = deps.logger.child({ clipPlanId: plan.id, rank: plan.rank });
    const storageKey = renderStorageKey(plan);
    const outputPath = deps.files.absolutePath(storageKey);

    const subtitles = buildClipSubtitles(plan, input.transcript, log);

    try {
      const result = await deps.renderClip({
        source: input.video,
        sourcePath,
        plan,
        outputPath,
        subtitles,
      });

      log.info('clip rendered', {
        storageKey,
        durationSec: result.rendered.durationSec,
        width: result.rendered.width,
        height: result.rendered.height,
        cues: result.cueCount,
        tracker: result.trackerId,
      });

      records.push(
        await deps.renders.save(
          buildClipRender(
            {
              videoId: plan.videoId,
              clipPlanId: plan.id,
              status: 'RENDERED',
              storageKey,
              durationSec: result.rendered.durationSec,
              width: result.rendered.width,
              height: result.rendered.height,
              fps: result.rendered.fps,
              sizeBytes: result.rendered.sizeBytes,
              hasAudio: result.rendered.hasAudio,
              cueCount: result.cueCount,
              trackerId: result.trackerId,
            },
            deps.newId,
          ),
        ),
      );
    } catch (error) {
      // The clip is lost, the run is not. The reason is stored rather than only
      // logged, because "why is there no clip 2?" has to be answerable from the
      // database alone.
      const app = toAppError(error);
      log.error('clip render failed', error, { storageKey });

      records.push(
        await deps.renders.save(
          buildClipRender(
            {
              videoId: plan.videoId,
              clipPlanId: plan.id,
              status: 'FAILED',
              cueCount: subtitles?.segments.length ?? 0,
              error: { kind: app.kind, code: app.code, message: app.message },
            },
            deps.newId,
          ),
        ),
      );

      // A missing toolchain will fail every remaining clip the same way, but
      // stopping early would leave those clips with no record at all, which is
      // the ambiguity this stage exists to remove. Each one gets its own row.
    }

    await input.onProgress?.(index + 1, plans.length);
  }

  return records;
}

/** Where a rendered clip lives. Flat under `renders/`, keyed by the plan's id. */
export const renderStorageKey = (plan: Pick<ClipPlan, 'id'>): string =>
  path.posix.join('renders', `${plan.id}.mp4`);

/**
 * Cues for one clip, or null when there are none worth burning.
 *
 * Every reason to end up with no captions is treated the same way — logged and
 * degraded to a clip without them. A subtitle problem is not a reason to lose
 * the Short.
 */
export function buildClipSubtitles(
  plan: ClipPlan,
  transcript: Transcript,
  log: Pick<Logger, 'debug' | 'warn'>,
): SubtitlePlan | null {
  const result = buildSubtitlePlan({ cuts: plan.cuts, segments: transcript.segments });

  if (!result.ok) {
    log.warn('no subtitles for clip', { reason: result.reason, issues: result.issues?.length ?? 0 });
    return null;
  }

  if (result.plan.segments.length === 0) {
    log.debug('clip has no speech to caption', { notes: result.plan.notes });
    return null;
  }

  // The verbatim guard, at the last point before the words are burned into
  // pixels: every cue must be traceable to the clip's own transcript text.
  const issues = verifySubtitleFidelity(result.plan.segments, plan.text);
  if (issues.length > 0) {
    log.warn('subtitles dropped: cues are not traceable to the transcript', {
      issues: issues.length,
      first: issues[0]?.reason,
    });
    return null;
  }

  return result.plan;
}
