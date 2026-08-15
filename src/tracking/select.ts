/**
 * Which tracker actually runs.
 *
 * The real detector is optional, and "optional" has to mean something stronger
 * than a flag: the native runtime may not be installed, the weights are not in
 * the repository and may never have been downloaded, and the tests must get the
 * deterministic tracker without arranging any of that. So selection is a
 * decision made once, explicitly, with a stated reason — not a `try/catch`
 * scattered through the pipeline.
 *
 * Every route through here ends at a working tracker. Asking for face tracking
 * on a machine with no model does not fail; it returns the centre tracker and
 * says why, and the caller can log that once instead of discovering it per clip.
 * The reason is a plain string so it can go straight into a log line or the
 * system status endpoint.
 *
 * Nothing here loads a model. Constructing `YuNetFaceDetector` is cheap; the
 * weights are read on its first frame.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Logger } from '@/lib/logger';
import { CenterSubjectTracker, NullSubjectTracker } from './dev-tracker';
import { DetectorSubjectTracker } from './detector-tracker';
import type { FrameSource } from './detection/frame-source';
import type { FrameDetector } from './detection/types';
import { LuminanceBlobDetector } from './detection/luminance';
import { YuNetFaceDetector } from './detection/yunet';
import type { SubjectTracker } from './types';

/**
 * - `center` — the deterministic development tracker. The default, and what the
 *   test suite uses unless it says otherwise.
 * - `face` — YuNet on ONNX Runtime. Needs the optional runtime and the weights.
 * - `luminance` — brightest-region saliency. No dependencies; a weak detector,
 *   useful on high-contrast footage and for end-to-end tests.
 * - `none` — track nothing, always centre-crop.
 */
export const SUBJECT_TRACKER_MODES = ['center', 'face', 'luminance', 'none'] as const;
export type SubjectTrackerMode = (typeof SUBJECT_TRACKER_MODES)[number];

export interface SubjectTrackerSelectionInput {
  readonly mode: SubjectTrackerMode;
  /** Path to the `.onnx` weights. Required by `face`, ignored otherwise. */
  readonly modelPath?: string | null;
  /**
   * How detector modes get pixels. Supplied by the caller because the tracking
   * layer has no video decoder and is not getting one.
   */
  readonly frames?: FrameSource;
  readonly fps?: number;
  readonly maxFrames?: number;
  readonly maxEdgePx?: number;
  /** Floor applied to both the detector's output and track association. */
  readonly minConfidence?: number;
  readonly logger?: Pick<Logger, 'debug' | 'warn'>;
}

export interface SubjectTrackerSelection {
  readonly tracker: SubjectTracker;
  /** What was asked for. */
  readonly requested: SubjectTrackerMode;
  /** What will run. Differs from `requested` when a prerequisite is missing. */
  readonly mode: SubjectTrackerMode;
  /** One sentence, safe to log or surface. */
  readonly reason: string;
  /** Non-null only for detector modes; the caller owns closing it. */
  readonly detector: FrameDetector | null;
}

/**
 * Resolve a mode into a tracker, degrading rather than failing.
 *
 * Async only because it checks that the weights exist before promising face
 * tracking — the alternative is a per-clip failure that looks like "no subject
 * found" and is nearly impossible to tell apart from footage with no faces.
 */
export async function createSubjectTracker(
  input: SubjectTrackerSelectionInput,
): Promise<SubjectTrackerSelection> {
  const requested = input.mode;

  if (requested === 'none') {
    return plain(requested, new NullSubjectTracker(), 'Subject tracking is disabled; every clip centre-crops.');
  }

  if (requested === 'center') {
    return plain(requested, new CenterSubjectTracker(), 'Using the deterministic centre tracker.');
  }

  if (!input.frames) {
    return degraded(requested, 'No frame source was provided, so no detector can run.');
  }

  if (requested === 'luminance') {
    const detector = new LuminanceBlobDetector({ minConfidence: input.minConfidence });
    return detectorSelection(requested, requested, detector, input, 'Using the luminance saliency detector.');
  }

  const modelPath = input.modelPath?.trim();
  if (!modelPath) {
    return degraded(requested, 'Face tracking needs a model path; none is configured.');
  }

  if (!(await isReadableFile(modelPath))) {
    return degraded(
      requested,
      `Face tracking model "${path.basename(modelPath)}" was not found; see README for how to fetch it.`,
    );
  }

  if (!isInstalled('onnxruntime-node')) {
    return degraded(requested, 'Face tracking needs the optional "onnxruntime-node" package, which is not installed.');
  }

  const detector = new YuNetFaceDetector({
    modelPath,
    ...(input.minConfidence === undefined ? {} : { minConfidence: input.minConfidence }),
  });

  return detectorSelection(
    requested,
    requested,
    detector,
    input,
    `Using the YuNet face detector (${path.basename(modelPath)}).`,
  );
}

/* -------------------------------------------------------------------------- */

const plain = (mode: SubjectTrackerMode, tracker: SubjectTracker, reason: string): SubjectTrackerSelection => ({
  tracker,
  requested: mode,
  mode,
  reason,
  detector: null,
});

/** Anything a detector mode cannot satisfy lands on the centre tracker. */
const degraded = (requested: SubjectTrackerMode, reason: string): SubjectTrackerSelection => ({
  tracker: new CenterSubjectTracker(),
  requested,
  mode: 'center',
  reason: `${reason} Falling back to the centre tracker.`,
  detector: null,
});

function detectorSelection(
  requested: SubjectTrackerMode,
  mode: SubjectTrackerMode,
  detector: FrameDetector,
  input: SubjectTrackerSelectionInput,
  reason: string,
): SubjectTrackerSelection {
  const tracker = new DetectorSubjectTracker({
    detector,
    frames: input.frames!,
    ...defined({
      fps: input.fps,
      maxFrames: input.maxFrames,
      maxEdgePx: input.maxEdgePx,
      logger: input.logger,
    }),
    ...(input.minConfidence === undefined ? {} : { association: { minConfidence: input.minConfidence } }),
  });

  return { tracker, requested, mode, reason, detector };
}

const isReadableFile = async (target: string): Promise<boolean> => {
  const stats = await fsp.stat(target).catch(() => null);
  return stats?.isFile() ?? false;
};

/**
 * Is a package installed, without loading it?
 *
 * `require.resolve` reads the package's manifest and stops. Importing
 * `onnxruntime-node` to find out would load a few hundred megabytes of native
 * runtime purely to answer a yes/no question, on a path taken during startup.
 */
export function isInstalled(specifier: string): boolean {
  try {
    createRequire(import.meta.url).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

const defined = <T extends object>(source: T): Partial<T> =>
  Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as Partial<T>;
