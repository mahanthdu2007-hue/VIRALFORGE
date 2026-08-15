/**
 * Local development provider.
 *
 * Deterministic and offline, so the pipeline, the API and the UI are all
 * exercisable without an API key or a bill. It is honest about being fake:
 * transcript text is bracketed and labelled `mock`, so it can never be mistaken
 * for something a person actually said.
 *
 * It exists to prove the abstraction and keep the product testable — it is
 * never a fallback for a failed real provider.
 */

import type {
  AiProvider,
  AudioSpec,
  CandidateClipDraft,
  ClipDiscoveryRequest,
  ClipRefinementDraft,
  ClipRefinementRequest,
  FramingDraft,
  FramingRequest,
  ProviderHealth,
  TranscriptionDraft,
  TranscriptionRequest,
  TranscriptSegmentDraft,
} from '../types';
import { validationError } from '@/lib/errors';
import { EMPTY_CLIP_SIGNALS } from '@/domain';

const MODEL = 'mock-v1';

/** Seconds of speech per synthetic segment. */
const SEGMENT_SEC = 5;

/** Words of synthetic speech per segment, after the `[mock …]` label. */
const WORDS_PER_SEGMENT = 5;

/**
 * Vocabulary the synthetic speech is drawn from.
 *
 * Wide on purpose. Every segment used to carry the same handful of words — the
 * label and its clock — which made every *clip* built from them lexically
 * near-identical, and ranking correctly rejected eleven distinct moments as the
 * same moment repeated. A run against the mock provider could therefore never
 * produce more than one Short, whatever the source, which hid the multi-clip
 * path from local development entirely.
 *
 * The pool is far larger than the number of words in one clip, so two clips
 * from different parts of a video share only a small fraction of their content
 * words — as two genuinely different moments of real speech would. Nothing here
 * is a judgement about the source: it is filler, and it stays behind the
 * `[mock …]` label so it can never be mistaken for something a person said.
 */
const MOCK_VOCABULARY = [
  'anchor', 'antenna', 'archive', 'atlas', 'balcony', 'ballast', 'beacon', 'bicycle',
  'blueprint', 'bramble', 'bridge', 'bucket', 'cadence', 'canyon', 'cargo', 'cellar',
  'chalk', 'chimney', 'cinder', 'compass', 'corridor', 'crater', 'crescent', 'cutlery',
  'dahlia', 'delta', 'dictionary', 'drawbridge', 'driftwood', 'echo', 'ember', 'envelope',
  'ferry', 'fixture', 'foghorn', 'foundry', 'garland', 'gazebo', 'glacier', 'granite',
  'harbour', 'hazel', 'hinge', 'hollow', 'inkwell', 'ironwork', 'jetty', 'junction',
  'kettle', 'keystone', 'lantern', 'lattice', 'ledger', 'lighthouse', 'lumber', 'marble',
  'meadow', 'mercury', 'mosaic', 'nebula', 'nutmeg', 'observatory', 'orchard', 'paddock',
  'parchment', 'pendulum', 'pigment', 'plateau', 'quarry', 'quilt', 'rafter', 'ravine',
  'rehearsal', 'ribbon', 'rudder', 'saffron', 'sandstone', 'satchel', 'scaffold', 'sextant',
  'shutter', 'signal', 'sledge', 'spindle', 'stairwell', 'sundial', 'tapestry', 'telescope',
  'thicket', 'timber', 'trellis', 'tundra', 'turbine', 'valley', 'vineyard', 'walnut',
  'waterfall', 'weathervane', 'willow', 'workshop',
] as const;

export function createMockProvider(): AiProvider {
  return {
    id: 'mock',
    displayName: 'Mock (local development)',
    capabilities: ['transcription', 'clip-discovery', 'clip-refinement', 'framing'],

    async health(): Promise<ProviderHealth> {
      return { ok: true, detail: 'Mock provider is always available.', checkedAt: new Date().toISOString() };
    },

    transcription: {
      audioSpec: { format: 'wav', sampleRateHz: 16_000, channels: 1 } satisfies AudioSpec,

      async transcribe(request: TranscriptionRequest): Promise<TranscriptionDraft> {
        assertPositive(request.durationSec, 'durationSec');

        const segments: TranscriptSegmentDraft[] = [];
        for (let start = 0; start < request.durationSec; start += SEGMENT_SEC) {
          const end = Math.min(start + SEGMENT_SEC, request.durationSec);
          const text = mockSegmentText(segments.length, start, end);
          segments.push({
            startSec: round3(start),
            endSec: round3(end),
            text,
            confidence: 1,
            // Word timings are synthesised by spreading the words evenly, so
            // downstream word-level code has something real to run against.
            words: spreadWords(text, start, end),
          });
        }

        return { language: request.languageHint ?? null, model: MODEL, segments };
      },
    },

    clipDiscovery: {
      async discoverClips(request: ClipDiscoveryRequest): Promise<readonly CandidateClipDraft[]> {
        assertPositive(request.videoDurationSec, 'videoDurationSec');
        if (request.maxCandidates < 1) {
          throw validationError('invalid_max_candidates', 'maxCandidates must be at least 1.');
        }

        const target = clamp(
          (request.targetDurationSec.min + request.targetDurationSec.max) / 2,
          request.targetDurationSec.min,
          Math.max(request.targetDurationSec.min, request.videoDurationSec),
        );

        const count = Math.max(1, Math.min(request.maxCandidates, Math.floor(request.videoDurationSec / target)));
        // Evenly spaced so the output is stable and candidates never overlap.
        const stride = request.videoDurationSec / count;

        return Array.from({ length: count }, (_, i) => {
          const startSec = Math.min(i * stride, Math.max(0, request.videoDurationSec - target));
          const endSec = Math.min(startSec + target, request.videoDurationSec);
          const intensity = round2(Math.max(0, 0.9 - i * 0.05));

          return {
            startSec: round3(startSec),
            endSec: round3(endSec),
            // Taken verbatim from the transcript so it passes the same verbatim
            // guard a real provider must pass. No special-casing for the mock.
            hookQuote: quoteAt(request, startSec, endSec),
            topic: `Mock moment ${i + 1}`,
            reason: 'Mock provider: evenly spaced placeholder moment, not real analysis.',
            signals: {
              ...EMPTY_CLIP_SIGNALS,
              strongOpening: i === 0,
              emotionalIntensity: intensity,
              informationDensity: intensity,
              standalone: intensity,
            },
            confidence: intensity,
          };
        });
      },
    },

    clipRefinement: {
      async refineClip(request: ClipRefinementRequest): Promise<ClipRefinementDraft> {
        assertPositive(request.endSec - request.startSec, 'clip duration');

        const words = request.clipText.split(/\s+/).filter(Boolean).length;
        // Derived from the text so it is deterministic and varies with input,
        // rather than a constant that would hide bugs in the blending.
        const density = clamp(words / 120, 0, 1);

        return {
          title: request.topic?.trim() || `Mock clip at ${formatClock(request.startSec)}`,
          // The first sentence, copied — the mock is held to the same verbatim
          // rule as a real provider.
          hookQuote: firstSentence(request.clipText),
          curiosity: round2(density * 0.8),
          standalone: round2(0.4 + density * 0.4),
          payoff: round2(density * 0.6),
          contextDependency: round2(0.3 - density * 0.2),
          notes: 'Mock provider: derived from text length, not real analysis.',
        };
      },
    },

    framing: {
      async planFraming(request: FramingRequest): Promise<FramingDraft> {
        const { sourceWidth, sourceHeight, targetAspectRatio } = request;
        assertPositive(sourceWidth, 'sourceWidth');
        assertPositive(sourceHeight, 'sourceHeight');

        // Widest 9:16 window that fits, centred.
        const width = Math.min(sourceWidth, Math.round(sourceHeight * targetAspectRatio));
        const height = Math.min(sourceHeight, Math.round(width / targetAspectRatio));

        return {
          strategy: 'static',
          keyframes: [
            {
              atSec: 0,
              x: Math.round((sourceWidth - width) / 2),
              y: Math.round((sourceHeight - height) / 2),
              width,
              height,
            },
          ],
          rationale: 'Mock provider: centre crop.',
        };
      },
    },
  };
}

/* -------------------------------------------------------------------------- */

const assertPositive = (value: number, field: string): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw validationError('invalid_request_field', `${field} must be a positive number.`, {
      details: { field, value },
    });
  }
};

/**
 * One segment of synthetic speech.
 *
 * Keeps the `[mock …]` label and its clock — that is what makes the text
 * impossible to mistake for real speech — and follows it with filler words
 * chosen deterministically from `MOCK_VOCABULARY` by segment index, so
 * different parts of a video read as different moments. Ends on a full stop so
 * boundary snapping and sentence splitting have something real to work with.
 */
export function mockSegmentText(index: number, startSec: number, endSec: number): string {
  const random = mulberry32(index + 1);
  const words: string[] = [];

  for (let i = 0; i < WORDS_PER_SEGMENT; i += 1) {
    words.push(MOCK_VOCABULARY[Math.floor(random() * MOCK_VOCABULARY.length)]!);
  }

  return `[mock ${formatClock(startSec)} to ${formatClock(endSec)}] ${words.join(' ')}.`;
}

/**
 * Small deterministic PRNG.
 *
 * The mock provider's whole value is being reproducible, so the filler cannot
 * come from `Math.random`: the same segment index must always produce the same
 * words, in this process and the next.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distributes a segment's words evenly across its time range. */
function spreadWords(text: string, startSec: number, endSec: number) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const step = (endSec - startSec) / words.length;

  return words.map((word, i) => ({
    text: word,
    startSec: round3(startSec + i * step),
    endSec: round3(i === words.length - 1 ? endSec : startSec + (i + 1) * step),
  }));
}

/** First sentence of the clip, copied exactly. Null when there is no text. */
function firstSentence(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const match = /^.*?[.!?…]/su.exec(trimmed);
  return (match?.[0] ?? trimmed).trim() || null;
}

/** First segment text overlapping the window, used verbatim as the hook. */
const quoteAt = (request: ClipDiscoveryRequest, startSec: number, endSec: number): string | null =>
  request.segments.find((s) => s.endSec > startSec && s.startSec < endSec)?.text.trim() ?? null;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
const round2 = (value: number): number => Math.round(value * 100) / 100;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const formatClock = (seconds: number): string => {
  const total = Math.floor(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
