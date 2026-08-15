/**
 * Subject tracking. Import from `@/tracking`, not deep paths.
 *
 * The layer has three responsibilities: say where the subject is
 * (`SubjectTracker`), turn that into framing (`buildCropPath`), and decide which
 * tracker a given installation can actually run (`createSubjectTracker`).
 *
 * It still depends on the domain and nothing else — no FFmpeg, no AI provider,
 * no transcript, no scoring. The real detector needs decoded frames, but it asks
 * for them through the `FrameSource` port declared here and implemented in the
 * media layer, so the dependency points inward: media knows about tracking,
 * tracking does not know about media. That is what keeps the whole detection
 * path testable from arrays of pixels, and what lets the deterministic tracker
 * remain the default with nothing installed.
 */

export * from './types';
export * from './dev-tracker';
export * from './crop-path';
export * from './detector-tracker';
export * from './select';
export * from './detection/types';
export * from './detection/frame-source';
export * from './detection/associate';
export * from './detection/luminance';
export * from './detection/yunet';
export * from './detection/yunet-decode';
