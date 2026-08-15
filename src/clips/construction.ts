/**
 * Clip construction.
 *
 * Turns a discovered moment — approximate boundaries, model-written metadata —
 * into a `ClipPlanDraft`: a concrete span of source timeline, snapped to real
 * transcript timings, carrying the verbatim speech it contains and everything
 * the renderer will later need.
 *
 * Three rules shape this file:
 *
 *  1. **Boundaries are decided by deterministic rules**, never by a model. The
 *     model may read a clip; it may not decide where a cut lands.
 *  2. **Spoken content is never altered.** `text` is assembled from transcript
 *     segments, and every quote is re-verified against it with the same guard
 *     discovery uses.
 *  3. **The AI layer is optional.** Refinement failing, or returning nonsense,
 *     costs a little scoring nuance and nothing else.
 *
 * No rendering happens here, and no video is read: this stage only ever touches
 * text and timestamps.
 */

import {
  nowIso,
  textInRange,
  verifyQuote,
  type CandidateClip,
  type ClipBoundaries,
  type ClipCut,
  type ClipSignals,
  type IsoTimestamp,
  type Transcript,
  type TranscriptSegmentId,
  type CandidateClipId,
  type TranscriptId,
  type VideoId,
} from '@/domain';
import type { ClipRefinementCapability } from '@/ai/types';
import type { Logger } from '@/lib/logger';
import { validateRefinement, type RefinementRejection } from '@/validation/clip-refinement';
import {
  chooseBoundaries,
  segmentsInRange,
  toSpeechTokens,
  DEFAULT_BOUNDARY_POLICY,
  type BoundaryPolicy,
  type SpeechToken,
} from './boundaries';
import { splitSentences } from './text';
import type { ClipSpeechStats, SemanticHints } from './scoring';

/**
 * A constructed clip, before scoring and ranking.
 *
 * Everything except `score` and `rank`, which are the next stage's job — kept
 * apart so construction can be tested without a scorer and vice versa.
 */
export interface ClipPlanDraft {
  readonly candidateClipId: CandidateClipId;
  readonly videoId: VideoId;
  readonly transcriptId: TranscriptId;
  readonly cuts: readonly ClipCut[];
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  /** Verbatim speech inside the final boundaries. */
  readonly text: string;
  readonly hookQuote: string | null;
  readonly topic: string | null;
  readonly title: string;
  readonly segmentIds: readonly TranscriptSegmentId[];
  readonly boundaries: ClipBoundaries;
  readonly speech: ClipSpeechStats;
  readonly signals: ClipSignals;
  /** Validated model reading, or null when unavailable or rejected. */
  readonly semantic: SemanticHints | null;
  readonly createdAt: IsoTimestamp;
}

export interface ClipConstructionOptions {
  readonly policy?: BoundaryPolicy;
  /** Omit to build clips with deterministic rules alone. */
  readonly refinement?: ClipRefinementCapability | null;
  readonly logger?: Logger;
}

/** A hook derived from the clip's own opening. Long openers read as a paragraph. */
const MAX_DERIVED_HOOK_CHARS = 180;

/**
 * Builds clip plans for one transcript.
 *
 * Stateful only in that it flattens the transcript into tokens once — that work
 * is shared by every candidate and is the expensive part.
 */
export class ClipConstruction {
  private readonly tokens: readonly SpeechToken[];
  private readonly policy: BoundaryPolicy;

  constructor(
    private readonly transcript: Transcript,
    private readonly mediaDurationSec: number,
    private readonly options: ClipConstructionOptions = {},
  ) {
    this.tokens = toSpeechTokens(transcript.segments);
    this.policy = options.policy ?? DEFAULT_BOUNDARY_POLICY;
  }

  /** Construct one clip. Never throws for a refinement failure. */
  async construct(candidate: CandidateClip): Promise<ClipPlanDraft> {
    const chosen = chooseBoundaries(
      this.tokens,
      { startSec: candidate.startSec, endSec: candidate.endSec },
      this.mediaDurationSec,
      this.policy,
    );

    const range = { startSec: chosen.startSec, endSec: chosen.endSec };
    const text = textInRange(this.transcript, range);
    const segments = segmentsInRange(this.transcript, range);

    const boundaries: ClipBoundaries = {
      startSnap: chosen.startSnap,
      endSnap: chosen.endSnap,
      startsOnSentence: chosen.startsOnSentence,
      endsOnSentence: chosen.endsOnSentence,
      startShiftSec: round3(chosen.startSec - candidate.startSec),
      endShiftSec: round3(chosen.endSec - candidate.endSec),
      notes: chosen.notes,
    };

    const refined = await this.refine(candidate, range, text);

    return {
      candidateClipId: candidate.id,
      videoId: candidate.videoId,
      transcriptId: candidate.transcriptId,
      cuts: [{ order: 0, startSec: chosen.startSec, endSec: chosen.endSec }],
      startSec: chosen.startSec,
      endSec: chosen.endSec,
      durationSec: round3(chosen.endSec - chosen.startSec),
      text,
      hookQuote: chooseHookQuote(text, refined?.hookQuote ?? null, candidate.hookQuote),
      topic: candidate.topic,
      title: refined?.title ?? fallbackTitle(candidate, chosen.startSec),
      segmentIds: segments.map((s) => s.id),
      boundaries,
      speech: measureSpeech(this.tokens, range),
      signals: candidate.signals,
      semantic: refined?.hints ?? null,
      createdAt: nowIso(),
    };
  }

  /** Construct every candidate, in order. */
  async constructAll(candidates: readonly CandidateClip[]): Promise<readonly ClipPlanDraft[]> {
    const drafts: ClipPlanDraft[] = [];
    // Sequential on purpose: refinement is one provider call per clip, and a
    // dozen at once is a rate limit rather than a speed-up.
    for (const candidate of candidates) {
      drafts.push(await this.construct(candidate));
    }
    return drafts;
  }

  /**
   * Ask the model to read the clip.
   *
   * Every failure mode — no capability, a thrown request, output that does not
   * validate — lands in the same place: null, logged, carry on with rules.
   */
  private async refine(
    candidate: CandidateClip,
    range: { startSec: number; endSec: number },
    text: string,
  ): Promise<{ title: string | null; hookQuote: string | null; hints: SemanticHints } | null> {
    const capability = this.options.refinement;
    if (!capability || text.trim().length === 0) return null;

    const log = this.options.logger;

    try {
      const draft = await capability.refineClip({
        clipText: text,
        startSec: range.startSec,
        endSec: range.endSec,
        topic: candidate.topic,
        ...(this.transcript.language ? { languageHint: this.transcript.language } : {}),
      });

      const { refinement, rejections } = validateRefinement(draft, text);
      logRejections(log, candidate.id, rejections);

      return refinement;
    } catch (error) {
      log?.warn('clip refinement failed; scoring with rules only', {
        candidateId: candidate.id,
        error: String(error),
      });
      return null;
    }
  }
}

const logRejections = (
  log: Logger | undefined,
  candidateId: CandidateClipId,
  rejections: readonly RefinementRejection[],
): void => {
  for (const rejection of rejections) {
    log?.warn('refinement output rejected', { candidateId, code: rejection.code, reason: rejection.reason });
  }
};

/* -------------------------------------------------------------------------- */
/* Text and quotes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Pick the line the clip leads with, in order of preference:
 *
 *  1. the model's suggestion, if it is genuinely in the clip;
 *  2. the candidate's original hook, if the new boundaries still contain it;
 *  3. the clip's own first sentence, which is verbatim by construction.
 *
 * Every branch is re-verified rather than assumed — snapping moves boundaries,
 * so a quote that was traceable before may no longer be inside the clip.
 */
export function chooseHookQuote(
  text: string,
  refined: string | null,
  candidateHook: string | null,
): string | null {
  for (const quote of [refined, candidateHook]) {
    if (quote && quote.trim().length > 0 && verifyQuote(quote, text).ok) return quote.trim();
  }

  const first = splitSentences(text)[0]?.trim();
  if (first && first.length > 0 && first.length <= MAX_DERIVED_HOOK_CHARS && verifyQuote(first, text).ok) {
    return first;
  }

  return null;
}

/**
 * A title when the model gave none.
 *
 * Uses the candidate's topic — the discovery model's own description of the
 * moment — or falls back to the timecode. Never a slice of speech: a title is
 * metadata, and a quoted sentence in a title position reads as a caption.
 */
export function fallbackTitle(candidate: Pick<CandidateClip, 'topic'>, startSec: number): string {
  const topic = candidate.topic?.trim();
  if (topic) return topic.length > 80 ? `${topic.slice(0, 79).trimEnd()}…` : topic;
  return `Moment at ${formatClock(startSec)}`;
}

/* -------------------------------------------------------------------------- */
/* Speech statistics                                                          */
/* -------------------------------------------------------------------------- */

/** Pace and dead air inside the final boundaries, measured from token timings. */
export function measureSpeech(
  tokens: readonly SpeechToken[],
  range: { startSec: number; endSec: number },
): ClipSpeechStats {
  const inside = tokens.filter((t) => t.startSec < range.endSec && t.endSec > range.startSec);
  const durationSec = Math.max(range.endSec - range.startSec, 0.001);

  const wordCount = inside.reduce(
    (total, token) => total + (token.source === 'word' ? 1 : countWords(token.text)),
    0,
  );

  let maxGapSec = 0;
  for (let i = 1; i < inside.length; i += 1) {
    maxGapSec = Math.max(maxGapSec, inside[i]!.startSec - inside[i - 1]!.endSec);
  }

  return {
    wordCount,
    wordsPerSecond: round3(wordCount / durationSec),
    maxGapSec: round3(Math.max(0, maxGapSec)),
  };
}

const countWords = (text: string): number => text.split(/\s+/u).filter(Boolean).length;

const formatClock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
