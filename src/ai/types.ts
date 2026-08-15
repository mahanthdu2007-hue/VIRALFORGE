/**
 * AI provider abstraction.
 *
 * Business logic depends only on this file. Gemini/OpenAI/NVIDIA adapters are
 * added under `providers/` and never leak their SDK types outward.
 *
 * Two rules shape these signatures:
 *  - Media is passed **by path**, never as bytes. Providers stream from disk or
 *    upload the file themselves; nothing loads a video into RAM.
 *  - Providers return *drafts*: plain data with no identifiers and no
 *    persistence concerns. The pipeline assigns ids and validates.
 */

import type { AiProviderId } from '@/config/env';
import type { ClipSignals, CropStrategy, TimeRange } from '@/domain';

export type { AiProviderId };

/** What a provider is able to do. Checked before dispatch, never assumed. */
export const AI_CAPABILITIES = ['transcription', 'clip-discovery', 'clip-refinement', 'framing'] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

export interface ProviderHealth {
  readonly ok: boolean;
  /** Why it is unhealthy — missing key, unreachable endpoint, quota. */
  readonly detail: string;
  readonly checkedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Transcription                                                              */
/* -------------------------------------------------------------------------- */

export type AudioFormat = 'wav' | 'ogg' | 'flac' | 'mp3';

/**
 * The audio a provider wants to be handed.
 *
 * Declaring it here keeps provider-specific encoding decisions out of the media
 * engine and out of the pipeline: the pipeline reads the spec and asks
 * `MediaService.extractAudio` for exactly that.
 */
export interface AudioSpec {
  readonly format: AudioFormat;
  readonly sampleRateHz: number;
  readonly channels: number;
  /** Upload ceiling, when the provider imposes one. */
  readonly maxBytes?: number;
}

export interface TranscriptionRequest {
  /** Absolute path to an audio file already extracted by the media engine. */
  readonly audioPath: string;
  readonly durationSec: number;
  /** BCP-47 hint; omit to let the provider detect. */
  readonly languageHint?: string;
}

/** Word-level timing, when the provider reports it. */
export interface TranscriptWordDraft extends TimeRange {
  readonly text: string;
}

export interface TranscriptSegmentDraft extends TimeRange {
  /** Verbatim speech. A provider that paraphrases is a bug. */
  readonly text: string;
  readonly confidence?: number;
  readonly speaker?: string;
  /** Omit entirely when the provider has no word-level granularity. */
  readonly words?: readonly TranscriptWordDraft[];
}

export interface TranscriptionDraft {
  readonly language: string | null;
  readonly model: string;
  readonly segments: readonly TranscriptSegmentDraft[];
}

export interface TranscriptionCapability {
  /** What to feed `transcribe`. Omitted means the engine default (16 kHz mono WAV). */
  readonly audioSpec?: AudioSpec;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionDraft>;
}

/* -------------------------------------------------------------------------- */
/* Clip discovery                                                             */
/* -------------------------------------------------------------------------- */

export interface ClipDiscoveryRequest {
  /** Timed verbatim transcript to reason over. */
  readonly segments: readonly (TimeRange & { readonly text: string })[];
  readonly videoDurationSec: number;
  /** How many moments to return, at most. */
  readonly maxCandidates: number;
  readonly targetDurationSec: { readonly min: number; readonly max: number };
  readonly languageHint?: string;
}

/**
 * A moment proposed by discovery.
 *
 * Boundaries are approximate: construction refines them later. `hookQuote` is
 * verified against the transcript before anything is persisted — a provider that
 * paraphrases gets its candidate rejected, not corrected.
 */
export interface CandidateClipDraft extends TimeRange {
  /** Must occur in the transcript — the opening line, not new copy. */
  readonly hookQuote: string | null;
  readonly topic: string | null;
  /** The model's justification, in its own words. Metadata, never dialogue. */
  readonly reason: string;
  readonly signals: ClipSignals;
  readonly confidence?: number;
}

export interface ClipDiscoveryCapability {
  discoverClips(request: ClipDiscoveryRequest): Promise<readonly CandidateClipDraft[]>;
}

/* -------------------------------------------------------------------------- */
/* Clip refinement                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A single constructed clip, handed back to the model for the one thing a model
 * does better than a word list: reading whether the passage actually works on
 * its own.
 *
 * Boundaries are *not* up for negotiation here — they were chosen by
 * deterministic snapping — so the request carries the final text, not the
 * candidate's approximate window.
 */
export interface ClipRefinementRequest {
  /** Verbatim speech the clip contains, already snapped to real boundaries. */
  readonly clipText: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly topic: string | null;
  readonly languageHint?: string;
}

/**
 * The model's reading of one clip.
 *
 * Every number is 0..1 and every one of them is re-checked before use;
 * `hookQuote` is verified against `clipText` and the whole refinement is
 * discarded if it was not actually said. Nothing here can move a boundary or
 * change what the clip contains — at most it adjusts a score and supplies a
 * title.
 */
export interface ClipRefinementDraft {
  /** Suggested title. Metadata about the clip, never presented as speech. */
  readonly title: string;
  /** A line copied from `clipText` to lead with, or null. */
  readonly hookQuote: string | null;
  /** Does it open a question worth staying for? */
  readonly curiosity: number;
  /** Does it make sense with nothing around it? */
  readonly standalone: number;
  /** Does it resolve what it raises? */
  readonly payoff: number;
  /** How much it leans on material outside the clip. Higher is worse. */
  readonly contextDependency: number;
  /** The model's own words on the clip. Diagnostic only. */
  readonly notes?: string | null;
}

export interface ClipRefinementCapability {
  refineClip(request: ClipRefinementRequest): Promise<ClipRefinementDraft>;
}

/* -------------------------------------------------------------------------- */
/* Framing                                                                    */
/* -------------------------------------------------------------------------- */

export interface FramingRequest {
  readonly clipRange: TimeRange;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly targetAspectRatio: number;
  /** Sampled frame paths (JPEGs on disk) the provider may inspect. */
  readonly sampleFramePaths: readonly string[];
}

export interface FramingDraft {
  readonly strategy: CropStrategy;
  readonly keyframes: readonly { atSec: number; x: number; y: number; width: number; height: number }[];
  readonly rationale: string | null;
}

export interface FramingCapability {
  planFraming(request: FramingRequest): Promise<FramingDraft>;
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

export interface AiProvider {
  readonly id: AiProviderId;
  readonly displayName: string;
  readonly capabilities: readonly AiCapability[];
  health(): Promise<ProviderHealth>;

  /** Present iff `capabilities` includes the matching entry. */
  readonly transcription?: TranscriptionCapability;
  readonly clipDiscovery?: ClipDiscoveryCapability;
  readonly clipRefinement?: ClipRefinementCapability;
  readonly framing?: FramingCapability;
}

export const supports = (provider: AiProvider, capability: AiCapability): boolean =>
  provider.capabilities.includes(capability);
