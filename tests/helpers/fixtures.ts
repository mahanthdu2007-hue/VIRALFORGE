/** Small builders so tests state only what they care about. */

import {
  CLIP_SCORE_COMPONENTS,
  CLIP_SCORE_PENALTIES,
  nowIso,
  SHORTS_ASPECT_RATIO,
  type CandidateClipId,
  type ClipBoundaries,
  type ClipCut,
  type ClipPlan,
  type ClipPlanId,
  type ClipScore,
  type MediaMetadata,
  type Transcript,
  type TranscriptId,
  type TranscriptSegment,
  type TranscriptSegmentId,
  type VideoAsset,
  type VideoId,
} from '@/domain';

export const VIDEO_ID = '11111111-1111-4111-8111-111111111111' as VideoId;

export const makeMetadata = (overrides: Partial<MediaMetadata> = {}): MediaMetadata => ({
  durationSec: 600,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  videoCodec: 'h264',
  audioCodec: 'aac',
  bitrate: 4_000_000,
  containerFormat: 'mov,mp4,m4a',
  ...overrides,
});

export const makeVideoAsset = (overrides: Partial<VideoAsset> = {}): VideoAsset => ({
  id: VIDEO_ID,
  originalFilename: 'talk.mp4',
  storageKey: `uploads/${VIDEO_ID}__talk.mp4`,
  sizeBytes: 250_000_000,
  mimeType: 'video/mp4',
  createdAt: nowIso(),
  metadata: makeMetadata(),
  ...overrides,
});

export const TRANSCRIPT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' as TranscriptId;

export const makeTranscript = (
  segments: readonly { startSec: number; endSec: number; text: string }[],
): Transcript => ({
  id: TRANSCRIPT_ID,
  videoId: VIDEO_ID,
  language: 'en',
  source: { provider: 'mock', model: 'mock-v1' },
  segments: segments.map(
    (s, index): TranscriptSegment => ({
      id: `seg-${index}` as TranscriptSegmentId,
      index,
      startSec: s.startSec,
      endSec: s.endSec,
      text: s.text,
      confidence: 1,
      speaker: null,
      words: null,
    }),
  ),
  createdAt: nowIso(),
});

export const makeClipBoundaries = (overrides: Partial<ClipBoundaries> = {}): ClipBoundaries => ({
  startSnap: 'word',
  endSnap: 'word',
  startsOnSentence: true,
  endsOnSentence: true,
  startShiftSec: 0,
  endShiftSec: 0,
  notes: [],
  ...overrides,
});

export const makeClipScore = (overrides: Partial<ClipScore> = {}): ClipScore => ({
  hook: 0.7,
  standalone: 0.7,
  emotion: 0.6,
  value: 0.6,
  overall: 0.65,
  rationale: 'Fixture score: no real analysis.',
  breakdown: {
    components: Object.fromEntries(CLIP_SCORE_COMPONENTS.map((key) => [key, 0.65])) as Record<
      (typeof CLIP_SCORE_COMPONENTS)[number],
      number
    >,
    penalties: Object.fromEntries(CLIP_SCORE_PENALTIES.map((key) => [key, 0])) as Record<
      (typeof CLIP_SCORE_PENALTIES)[number],
      number
    >,
    weights: {
      components: Object.fromEntries(CLIP_SCORE_COMPONENTS.map((key) => [key, 0.1])) as Record<
        (typeof CLIP_SCORE_COMPONENTS)[number],
        number
      >,
      penalties: Object.fromEntries(CLIP_SCORE_PENALTIES.map((key) => [key, 0.1])) as Record<
        (typeof CLIP_SCORE_PENALTIES)[number],
        number
      >,
    },
    componentTotal: 0.65,
    penaltyTotal: 0,
    aiAssisted: false,
  },
  ...overrides,
});

export const makeClipPlan = (cuts: readonly ClipCut[], overrides: Partial<ClipPlan> = {}): ClipPlan => {
  const durationSec = cuts.reduce((total, cut) => total + (cut.endSec - cut.startSec), 0);

  return {
    id: 'plan-1' as ClipPlanId,
    videoId: VIDEO_ID,
    transcriptId: TRANSCRIPT_ID,
    candidateClipId: 'cand-1' as CandidateClipId,
    rank: 1,
    title: 'The part nobody expected',
    cuts,
    durationSec,
    text: 'We tried it anyway. It worked.',
    hookQuote: 'We tried it anyway.',
    topic: 'The part nobody expected',
    segmentIds: ['seg-0' as TranscriptSegmentId],
    boundaries: makeClipBoundaries(),
    score: makeClipScore(),
    cropPlan: {
      strategy: 'static',
      source: { width: 1920, height: 1080 },
      output: { width: 1080, height: 1920 },
      targetAspectRatio: SHORTS_ASPECT_RATIO,
      keyframes: [{ atSec: 0, x: 420, y: 0, width: 594, height: 1056 }],
      rationale: null,
    },
    subtitles: [],
    createdAt: nowIso(),
    ...overrides,
  };
};
