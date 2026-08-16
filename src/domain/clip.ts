import type { Brand, IsoTimestamp, TimeRange, UnitScore } from './common';
import type { TranscriptId, TranscriptSegmentId } from './transcript';
import type { VideoId } from './video';
import type { CropPlan } from './crop';
import type { SubtitleSegment } from './subtitle';

export type CandidateClipId = Brand<string, 'CandidateClipId'>;
export type ClipPlanId = Brand<string, 'ClipPlanId'>;

/** Target length window for a finished Short. */
export const SHORT_MIN_DURATION_SEC = 30;
export const SHORT_MAX_DURATION_SEC = 40;

/** Window a discovered moment should normally fall inside, before construction. */
export const CANDIDATE_MIN_DURATION_SEC = 20;
export const CANDIDATE_MAX_DURATION_SEC = 60;

/**
 * Qualitative traits observed in a moment.
 *
 * Discovery reports these; the later scoring phase decides what they are worth.
 * Booleans are presence flags, numbers are 0..1 intensities. New signals may be
 * appended — consumers must treat unknown-but-absent as "not observed" rather
 * than assuming the set is closed.
 */
export interface ClipSignals {
  /** Opens on a statement strong enough to stand as the first line. */
  readonly strongOpening: boolean;
  /** Poses a question and answers it inside the window. */
  readonly questionAnswered: boolean;
  /** Contains a clearly stated opinion or stance. */
  readonly strongOpinion: boolean;
  /** Contains information likely to surprise the listener. */
  readonly surprise: boolean;
  /** Narrative shape: setup and movement, not just assertion. */
  readonly story: boolean;
  /** Resolves the tension it sets up. */
  readonly payoff: boolean;
  /** Emotional intensity, 0..1. */
  readonly emotionalIntensity: UnitScore;
  /** Density of concrete, useful information, 0..1. */
  readonly informationDensity: UnitScore;
  /** How well it stands alone without surrounding context, 0..1. */
  readonly standalone: UnitScore;
}

export const EMPTY_CLIP_SIGNALS: ClipSignals = {
  strongOpening: false,
  questionAnswered: false,
  strongOpinion: false,
  surprise: false,
  story: false,
  payoff: false,
  emotionalIntensity: 0,
  informationDensity: 0,
  standalone: 0,
};

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Positive dimensions of a clip's quality.
 *
 * Each is a 0..1 measurement of one property, combined by a weighted sum. They
 * are listed rather than free-form so a breakdown can never carry a dimension
 * the weights do not know about.
 */
export const CLIP_SCORE_COMPONENTS = [
  /** Does the first line earn the next five seconds? */
  'hook',
  /** Does it open a question the viewer wants closed? */
  'curiosity',
  /** Emotional intensity of the language. */
  'emotion',
  /** Density of concrete, useful information. */
  'information',
  /** Does it make sense with nothing around it? */
  'standalone',
  /** Does the tension it sets up get resolved inside the clip? */
  'payoff',
  /** Does it run as one whole thought — hook, context, development, landing? */
  'structure',
  /** Pace: speech that keeps moving, without dead air. */
  'momentum',
  /** Does it begin on a clean, complete thought? */
  'opening',
  /** Does it end on a clean, complete thought? */
  'ending',
  /** How close the runtime is to the 30–40s target. */
  'duration',
] as const;

export type ClipScoreComponent = (typeof CLIP_SCORE_COMPONENTS)[number];

/**
 * Negative dimensions, each 0..1, subtracted from the weighted component total.
 * Kept separate from components so a debug view can show what a clip lost, not
 * just what it earned.
 */
export const CLIP_SCORE_PENALTIES = [
  /** Ums, ahs, and verbal padding. */
  'filler',
  /** The same thing said more than once. */
  'repetition',
  /** Depends on something said outside the clip. */
  'contextDependency',
  /** Greetings, sign-offs, calls to action — speech that is not content. */
  'boilerplate',
  /**
   * An advertisement: a sponsor read, a product plug, an affiliate pitch.
   *
   * Separate from `boilerplate` and weighted far harder, because the two fail
   * differently. Housekeeping is *dull* — it wastes the clip's seconds. An ad is
   * actively wrong: publishing someone else's sponsor segment as your Short
   * hands a viewer a commercial they did not ask for, and there is no amount of
   * hook or payoff that redeems it. Boilerplate should lose; this should not
   * ship.
   */
  'promotional',
] as const;

export type ClipScorePenalty = (typeof CLIP_SCORE_PENALTIES)[number];

/** The tunable part of scoring. Held as data so weights are configuration. */
export interface ClipScoreWeights {
  readonly components: Readonly<Record<ClipScoreComponent, number>>;
  readonly penalties: Readonly<Record<ClipScorePenalty, number>>;
}

/**
 * Every input to the final number, kept so "why did this clip win?" is
 * answerable from the stored record alone — including the weights in force when
 * it was scored, which may since have changed.
 */
export interface ClipScoreBreakdown {
  readonly components: Readonly<Record<ClipScoreComponent, UnitScore>>;
  readonly penalties: Readonly<Record<ClipScorePenalty, UnitScore>>;
  readonly weights: ClipScoreWeights;
  /** Weighted sum of the components, before penalties. */
  readonly componentTotal: number;
  /** Weighted sum of the penalties, as subtracted. */
  readonly penaltyTotal: number;
  /** Whether validated model input contributed to any component. */
  readonly aiAssisted: boolean;
}

/**
 * Why a moment is worth clipping, broken into dimensions so the ranking is
 * inspectable rather than a single opaque number.
 *
 * The four headline axes are a summary for the UI; `breakdown` is the whole
 * truth. `overall` is a *relative* quality measure used to rank this video's own
 * moments against each other — it is not a prediction that anything will go
 * viral, and nothing in this codebase treats it as one.
 *
 * Produced by the scoring phase — discovery leaves it null.
 */
export interface ClipScore {
  /** Does the opening earn attention in the first 2 seconds? */
  readonly hook: UnitScore;
  /** Does it stand alone without surrounding context? */
  readonly standalone: UnitScore;
  /** Emotional intensity or surprise. */
  readonly emotion: UnitScore;
  /** Concrete takeaway or payoff for the viewer. */
  readonly value: UnitScore;
  /** Weighted aggregate used for ranking, 0..1. */
  readonly overall: UnitScore;
  /** Plain-language summary of what drove the number. Generated, not spoken. */
  readonly rationale: string;
  readonly breakdown: ClipScoreBreakdown;
}

/**
 * A viral moment discovered on the source timeline. Not yet a Short: the
 * boundaries are approximate and construction will refine them to 30–40s.
 */
export interface CandidateClip extends TimeRange {
  readonly id: CandidateClipId;
  readonly videoId: VideoId;
  readonly transcriptId: TranscriptId;
  /** Transcript segments this moment covers, in order. */
  readonly segmentIds: readonly TranscriptSegmentId[];
  /**
   * Verbatim transcript text spanned by the moment. Stored so later phases can
   * reason — and re-verify quotes — without re-reading the whole transcript.
   */
  readonly text: string;
  /**
   * Verbatim line that opens the moment. Never AI-written: it has passed
   * `verifyQuote` against `text` before this object exists.
   */
  readonly hookQuote: string | null;
  readonly topic: string | null;
  /** The discovery model's stated reason, in its own words. Metadata, not dialogue. */
  readonly reason: string;
  readonly signals: ClipSignals;
  /** Provider confidence in the moment, 0..1, or null when unsupported. */
  readonly confidence: UnitScore | null;
  /** Filled by the scoring phase; null while only discovery has run. */
  readonly score: ClipScore | null;
  readonly createdAt: IsoTimestamp;
}

/** Runtime of the discovered moment, in seconds. */
export const candidateDuration = (candidate: TimeRange): number =>
  candidate.endSec - candidate.startSec;

/**
 * Whether a moment is long enough to build a Short from and short enough to be
 * one coherent idea. Deliberately wider than the final 30–40s target — trimming
 * is the construction phase's job.
 */
export const isWithinCandidateDuration = (durationSec: number): boolean =>
  durationSec >= CANDIDATE_MIN_DURATION_SEC && durationSec <= CANDIDATE_MAX_DURATION_SEC;

/** One contiguous piece of source video pulled into a Short. */
export interface ClipCut extends TimeRange {
  /** Position within the Short, ascending. */
  readonly order: number;
}

/**
 * Hard limits on a constructed clip.
 *
 * 30–40s is the *target*; some material genuinely will not fit it — a complete
 * thought that runs 44s is a better Short than the same thought cut off at 40.
 * These bounds are where a clip stops being one, and construction refuses
 * rather than truncating mid-sentence.
 */
export const CLIP_HARD_MIN_DURATION_SEC = 15;
export const CLIP_HARD_MAX_DURATION_SEC = 55;

/** Where a boundary ended up sitting. */
export type BoundarySnap =
  /** On a transcript word boundary. */
  | 'word'
  /** On a segment boundary, because no word timings were available. */
  | 'segment'
  /** Left where the candidate had it — no anchor was usable. */
  | 'candidate'
  /** Clamped to the start or end of the media. */
  | 'media';

/**
 * How the final boundaries were chosen, recorded so a surprising cut can be
 * explained without re-running construction.
 */
export interface ClipBoundaries {
  readonly startSnap: BoundarySnap;
  readonly endSnap: BoundarySnap;
  /** The clip begins where a sentence begins. */
  readonly startsOnSentence: boolean;
  /** The clip ends where a sentence ends. */
  readonly endsOnSentence: boolean;
  /** Seconds moved from the candidate's boundary; positive means later. */
  readonly startShiftSec: number;
  readonly endShiftSec: number;
  /** Machine-readable notes, e.g. `no_sentence_end_anchor`. */
  readonly notes: readonly string[];
}

/**
 * A constructed Short: which source ranges to take, the verbatim speech they
 * carry, and why it ranked where it did.
 *
 * `cuts` allows trimming dead air out of the middle of a moment while keeping
 * the result coherent. Every plan built today has a single cut.
 *
 * `cropPlan` and `subtitles` are the rendering pipeline's inputs and stay
 * empty until those phases exist — a plan is complete for ranking and
 * inspection without them.
 */
export interface ClipPlan {
  readonly id: ClipPlanId;
  readonly videoId: VideoId;
  readonly transcriptId: TranscriptId;
  readonly candidateClipId: CandidateClipId;
  /** Rank among the selected Shorts, 1-based. */
  readonly rank: number;
  /** Suggested title for the Short. Metadata only — never spoken content. */
  readonly title: string;
  readonly cuts: readonly ClipCut[];
  /** Sum of the cut durations. Stored so a query need not recompute it. */
  readonly durationSec: number;
  /**
   * Verbatim transcript text the clip carries. Never rewritten: subtitles and
   * any quote must be traceable to this.
   */
  readonly text: string;
  /** Verbatim opening line, already checked against `text`. */
  readonly hookQuote: string | null;
  readonly topic: string | null;
  readonly segmentIds: readonly TranscriptSegmentId[];
  readonly boundaries: ClipBoundaries;
  readonly score: ClipScore;
  /** Filled by the framing phase. */
  readonly cropPlan: CropPlan | null;
  /** Filled by the subtitle phase. */
  readonly subtitles: readonly SubtitleSegment[];
  readonly createdAt: IsoTimestamp;
}

/** Total runtime of the Short in seconds. */
export const clipPlanDuration = (plan: Pick<ClipPlan, 'cuts'>): number =>
  plan.cuts.reduce((total, cut) => total + (cut.endSec - cut.startSec), 0);

/** The span of source timeline the plan draws from, first cut to last. */
export function clipPlanSourceRange(plan: Pick<ClipPlan, 'cuts'>): TimeRange {
  const starts = plan.cuts.map((cut) => cut.startSec);
  const ends = plan.cuts.map((cut) => cut.endSec);
  return { startSec: Math.min(...starts), endSec: Math.max(...ends) };
}

/** Whether the plan lands inside the 30–40s target window. */
export const isWithinShortDuration = (durationSec: number): boolean =>
  durationSec >= SHORT_MIN_DURATION_SEC && durationSec <= SHORT_MAX_DURATION_SEC;

/** Whether the plan is a usable Short at all, target window or not. */
export const isWithinClipHardLimits = (durationSec: number): boolean =>
  durationSec >= CLIP_HARD_MIN_DURATION_SEC && durationSec <= CLIP_HARD_MAX_DURATION_SEC;
