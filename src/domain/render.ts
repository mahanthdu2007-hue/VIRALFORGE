/**
 * The record of one attempt to turn a `ClipPlan` into a file.
 *
 * Separate from `RenderResult` on a render *job*: that describes a job's
 * outcome, this describes a **clip's** outcome, and the render stage produces
 * one per selected Short whether or not it succeeded. A failed clip is a row
 * here, not a gap — which is the whole point: three clips are rendered one
 * after another, and the two that worked must remain findable when the third
 * did not.
 *
 * Bytes live on disk under `storageKey`, exactly as uploads do; nothing in this
 * type holds media.
 */

import type { Brand, IsoTimestamp } from './common';
import type { ClipPlanId } from './clip';
import type { VideoId } from './video';
import type { ErrorKind } from '@/lib/errors';

export type ClipRenderId = Brand<string, 'ClipRenderId'>;

export const CLIP_RENDER_STATUSES = ['RENDERED', 'FAILED'] as const;
export type ClipRenderStatus = (typeof CLIP_RENDER_STATUSES)[number];

/** Why a clip did not render. Mirrors the serialisable part of `AppError`. */
export interface ClipRenderError {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly message: string;
}

/**
 * One clip's rendered artefact, or the reason there isn't one.
 *
 * Every measured field is null on a failure and is read off the finished file
 * — never assumed from the plan — on a success, so a mismatch between what was
 * planned and what was produced is visible rather than papered over.
 */
export interface ClipRender {
  readonly id: ClipRenderId;
  readonly videoId: VideoId;
  readonly clipPlanId: ClipPlanId;
  readonly status: ClipRenderStatus;
  /** Path relative to the storage root, POSIX-separated. Null when failed. */
  readonly storageKey: string | null;
  readonly durationSec: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly sizeBytes: number | null;
  readonly hasAudio: boolean | null;
  /** Captions burned in. Zero means the clip rendered without subtitles. */
  readonly cueCount: number;
  /** Which tracker framed it, or null when the render never got that far. */
  readonly trackerId: string | null;
  readonly error: ClipRenderError | null;
  readonly createdAt: IsoTimestamp;
}

export const isRendered = (render: ClipRender): boolean => render.status === 'RENDERED';
