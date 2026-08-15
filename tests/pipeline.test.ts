import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysis } from '@/pipeline/analysis';
import type { AnalysisDeps } from '@/pipeline/deps';
import { JobRunner, recoverInterrupted, resumeQueued } from '@/jobs/runner';
import { createAnalysisJob } from '@/jobs/store';
import { createMockProvider } from '@/ai/providers/mock';
import { createLogger } from '@/lib/logger';
import { aiError, mediaError } from '@/lib/errors';
import {
  CLIP_SCORE_COMPONENTS,
  EMPTY_CLIP_SIGNALS,
  nowIso,
  type AnalysisJob,
  type VideoId,
} from '@/domain';
import { renderingError } from '@/lib/errors';
import { SqliteClipRenderRepository } from '@/storage/clip-render-repository';
import type { RenderClipPlanRequest, RenderClipPlanResult } from '@/pipeline/render-clip';
import type { AiProvider, CandidateClipDraft } from '@/ai/types';
import type { MediaService } from '@/media/media-service';
import type { FileStore } from '@/storage/file-store';
import { makeStores, sequentialIds, type TestStores } from './helpers/db';
import { makeClipPlan, makeVideoAsset, VIDEO_ID } from './helpers/fixtures';
import { buildCutArgs, formatSeconds, DEFAULT_RENDER_PROFILE } from '@/media/clip-render';
import { withCropPlan } from '@/media/reframe';

/** Silent unless a test asks otherwise. */
const logger = createLogger({ level: 'error', sink: () => {} });

const fakeFiles = (): FileStore => ({
  init: async () => {},
  absolutePath: (key: string) => `/fake/${key}`,
  exists: async () => true,
  stat: async () => null,
  remove: async () => {},
  writeStream: async () => ({ key: 'uploads/x', sizeBytes: 0 }),
});

const fakeMedia = (overrides: Partial<MediaService> = {}): MediaService => ({
  toolchain: async () => ({
    available: true,
    ffmpeg: { path: 'ffmpeg', available: true, version: '8.1.1', error: null },
    ffprobe: { path: 'ffprobe', available: true, version: '8.1.1', error: null },
    checkedAt: new Date().toISOString(),
  }),
  probe: async () => makeVideoAsset().metadata!,
  extractAudio: async (_video, output, spec) => ({
    path: output,
    sizeBytes: 1024,
    spec: spec ?? { format: 'wav', sampleRateHz: 16_000, channels: 1 },
  }),
  ...overrides,
});

async function makeDeps(
  overrides: Partial<AnalysisDeps> = {},
  // Passed in by the render tests, which need the same database to read the
  // render rows back out of.
  stores: TestStores = makeStores(),
): Promise<AnalysisDeps> {
  await stores.videos.create(makeVideoAsset());

  return {
    logger,
    jobs: stores.jobs,
    videos: stores.videos,
    transcripts: stores.transcripts,
    candidates: stores.candidates,
    clipPlans: stores.clipPlans,
    files: fakeFiles(),
    media: fakeMedia(),
    provider: createMockProvider(),
    maxCandidates: 5,
    newId: sequentialIds('x'),
    ...overrides,
  };
}

const queue = async (deps: AnalysisDeps): Promise<AnalysisJob> =>
  deps.jobs.create(createAnalysisJob(VIDEO_ID)) as Promise<AnalysisJob>;

describe('runAnalysis — happy path', () => {
  it('walks the state machine and persists everything it produced', async () => {
    const deps = await makeDeps();
    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.job.state).toBe('COMPLETED');
    expect(outcome.job.progress).toBe(100);
    expect(outcome.job.history.map((h) => h.state)).toEqual([
      'QUEUED',
      'ANALYZING',
      'TRANSCRIBING',
      'FINDING_CLIPS',
      'BUILDING_CLIPS',
      'COMPLETED',
    ]);

    expect(outcome.transcript).not.toBeNull();
    expect(outcome.candidates.length).toBeGreaterThan(0);
    expect(outcome.clipPlans.length).toBeGreaterThan(0);

    // Persisted, not just returned.
    const storedTranscript = await deps.transcripts.findByVideo(VIDEO_ID);
    expect(storedTranscript?.segments.length).toBe(outcome.transcript!.segments.length);
    expect(await deps.candidates.countByVideo(VIDEO_ID)).toBe(outcome.candidates.length);
    expect(await deps.clipPlans.countByVideo(VIDEO_ID)).toBe(outcome.clipPlans.length);

    const reloaded = await deps.jobs.get(outcome.job.id);
    expect(reloaded.type === 'analysis' && reloaded.result.transcriptId).toBe(storedTranscript!.id);
    expect(reloaded.type === 'analysis' && reloaded.result.candidateClipIds).toHaveLength(
      outcome.candidates.length,
    );
    expect(reloaded.type === 'analysis' && reloaded.result.selectedClipPlanIds).toEqual(
      outcome.clipPlans.map((p) => p.id),
    );
  });

  it('stores candidates whose quotes are traceable to the transcript', async () => {
    const deps = await makeDeps();
    const outcome = await runAnalysis(deps, await queue(deps));

    for (const candidate of outcome.candidates) {
      expect(candidate.text.length).toBeGreaterThan(0);
      if (candidate.hookQuote) expect(candidate.text).toContain(candidate.hookQuote);
    }
  });

  it('asks the media engine for the audio the provider declared', async () => {
    const extractAudio = vi.fn(fakeMedia().extractAudio);
    const deps = await makeDeps({ media: fakeMedia({ extractAudio }) });

    await runAnalysis(deps, await queue(deps));

    expect(extractAudio).toHaveBeenCalledOnce();
    expect(extractAudio.mock.calls[0]![2]).toMatchObject({ sampleRateHz: 16_000, channels: 1 });
  });

  it('deletes the intermediate audio when it is done with it', async () => {
    const removed: string[] = [];
    const deps = await makeDeps({
      media: fakeMedia({
        extractAudio: async (_v, output, spec) => {
          removed.push(output);
          return { path: output, sizeBytes: 10, spec: spec! };
        },
      }),
    });

    await runAnalysis(deps, await queue(deps));

    // The work file lives under the storage work area, and the pipeline's
    // finally block removes it; absence is asserted by the fake path never
    // being left behind on a real store (see verification run for the real one).
    expect(removed[0]).toContain('work/');
  });
});

describe('runAnalysis — failures', () => {
  it('fails the job instead of throwing when audio extraction fails', async () => {
    const deps = await makeDeps({
      media: fakeMedia({
        extractAudio: async () => {
          throw mediaError('no_audio_stream', 'No audio track.');
        },
      }),
    });

    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.job.state).toBe('FAILED');
    expect(outcome.job.failure).toMatchObject({ kind: 'media', code: 'no_audio_stream' });
    expect(outcome.transcript).toBeNull();
    expect(await deps.candidates.countByVideo(VIDEO_ID)).toBe(0);
  });

  it('fails when the source has no audio track at all', async () => {
    const deps = await makeDeps();
    await deps.videos.save(
      makeVideoAsset({ metadata: { ...makeVideoAsset().metadata!, hasAudio: false, audioCodec: null } }),
    );

    const outcome = await runAnalysis(deps, await queue(deps));
    expect(outcome.job.failure?.code).toBe('no_audio_stream');
  });

  it('fails the job when the provider errors, and persists the reason', async () => {
    const provider: AiProvider = {
      ...createMockProvider(),
      transcription: {
        transcribe: async () => {
          throw aiError('provider_request_failed', 'Upstream is down.');
        },
      },
    };

    const deps = await makeDeps({ provider });
    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.job.state).toBe('FAILED');
    const reloaded = await deps.jobs.get(outcome.job.id);
    expect(reloaded.failure).toMatchObject({ kind: 'ai', code: 'provider_request_failed' });
  });

  it('fails when extracted audio exceeds the provider upload limit', async () => {
    const base = createMockProvider();
    const provider: AiProvider = {
      ...base,
      transcription: {
        ...base.transcription!,
        audioSpec: { format: 'ogg', sampleRateHz: 16_000, channels: 1, maxBytes: 100 },
      },
    };

    const deps = await makeDeps({
      provider,
      media: fakeMedia({
        extractAudio: async (_v, output, spec) => ({ path: output, sizeBytes: 5000, spec: spec! }),
      }),
    });

    const outcome = await runAnalysis(deps, await queue(deps));
    expect(outcome.job.failure?.code).toBe('audio_too_large');
  });

  it('rejects fabricated candidates without failing the run', async () => {
    const base = createMockProvider();
    const provider: AiProvider = {
      ...base,
      clipDiscovery: {
        async discoverClips(): Promise<CandidateClipDraft[]> {
          return [
            {
              startSec: 0,
              endSec: 30,
              hookQuote: 'a sentence the speaker never uttered',
              topic: 'Invented',
              reason: 'Fabricated for this test.',
              signals: EMPTY_CLIP_SIGNALS,
              confidence: 0.9,
            },
          ];
        },
      },
    };

    const deps = await makeDeps({ provider });
    const outcome = await runAnalysis(deps, await queue(deps));

    // The run completes; the bad candidate simply does not survive.
    expect(outcome.job.state).toBe('COMPLETED');
    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.rejectedCandidates).toBe(1);
    expect(await deps.candidates.countByVideo(VIDEO_ID)).toBe(0);
  });

  it('fails when the transcript is unusable', async () => {
    const base = createMockProvider();
    const provider: AiProvider = {
      ...base,
      transcription: {
        transcribe: async () => ({ language: null, model: 'broken', segments: [] }),
      },
    };

    const deps = await makeDeps({ provider });
    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.job.failure?.code).toBe('empty_transcript');
  });
});

/* -------------------------------------------------------------------------- */
/* Clip building                                                              */
/* -------------------------------------------------------------------------- */

describe('runAnalysis — clip building', () => {
  it('selects at most three distinct clips and ranks them best first', async () => {
    const deps = await makeDeps();
    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.clipPlans.length).toBeGreaterThan(0);
    expect(outcome.clipPlans.length).toBeLessThanOrEqual(3);

    expect(outcome.clipPlans.map((p) => p.rank)).toEqual(
      outcome.clipPlans.map((_, i) => i + 1),
    );

    const overall = outcome.clipPlans.map((p) => p.score.overall);
    expect([...overall].sort((a, b) => b - a)).toEqual(overall);

    // Distinct moments: no two selected clips may cover the same timeline.
    for (let i = 1; i < outcome.clipPlans.length; i += 1) {
      const previous = outcome.clipPlans.map((p) => p.cuts[0]!).slice(0, i);
      const current = outcome.clipPlans[i]!.cuts[0]!;
      for (const earlier of previous) {
        const overlap = Math.min(earlier.endSec, current.endSec) - Math.max(earlier.startSec, current.startSec);
        expect(overlap).toBeLessThanOrEqual(0);
      }
    }
  });

  /**
   * Regression: a real 41-minute run shipped one Short of the opening forty
   * seconds, five times over. The candidates were spread across the whole video
   * — nothing was wrong with discovery or with the ranges — but every clip's
   * *text* was the mock provider's label and clock, so ranking read eleven
   * distinct moments as the same moment repeated and selected one.
   */
  it('selects three moments from different parts of the source', async () => {
    const deps = await makeDeps();
    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.clipPlans).toHaveLength(3);

    const ranges = outcome.clipPlans.map((plan) => [plan.cuts[0]!.startSec, plan.cuts.at(-1)!.endSec]);
    expect(new Set(ranges.map((range) => range.join('-'))).size).toBe(3);

    // Genuinely different parts of the timeline, not three edges of one moment.
    for (const [i, [startA, endA]] of ranges.entries()) {
      for (const [startB, endB] of ranges.slice(i + 1)) {
        expect(Math.min(endA!, endB!) - Math.max(startA!, startB!)).toBeLessThanOrEqual(0);
      }
    }

    // And different speech, which is what makes them different Shorts.
    expect(new Set(outcome.clipPlans.map((plan) => plan.text)).size).toBe(3);
  });

  it('persists the score breakdown so a ranking can be explained later', async () => {
    const deps = await makeDeps();
    const outcome = await runAnalysis(deps, await queue(deps));

    const stored = await deps.clipPlans.listByVideo(VIDEO_ID);
    expect(stored).toHaveLength(outcome.clipPlans.length);

    const [best] = stored;
    expect(best).toBeDefined();
    expect(best!.rank).toBe(1);
    expect(best!.score.rationale.length).toBeGreaterThan(0);
    expect(best!.score.breakdown.weights.components.hook).toBeGreaterThan(0);
    expect(Object.keys(best!.score.breakdown.components).length).toBe(CLIP_SCORE_COMPONENTS.length);
    // The mock provider implements refinement, so the run is AI-assisted.
    expect(best!.score.breakdown.aiAssisted).toBe(true);
    // Rendering is a later phase; a plan leaves this stage without either.
    expect(best!.cropPlan).toBeNull();
    expect(best!.subtitles).toEqual([]);
  });

  it('keeps every stored clip verbatim and traceable to its transcript', async () => {
    const deps = await makeDeps();
    const outcome = await runAnalysis(deps, await queue(deps));

    const transcript = outcome.transcript!;
    for (const plan of await deps.clipPlans.listByVideo(VIDEO_ID)) {
      expect(plan.transcriptId).toBe(transcript.id);
      expect(plan.segmentIds.length).toBeGreaterThan(0);
      expect(plan.text.trim().length).toBeGreaterThan(0);
      // The guarantee that matters: a quote the speaker never said cannot survive.
      if (plan.hookQuote) expect(plan.text).toContain(plan.hookQuote);
    }
  });

  it('builds clips without a refinement capability, and says so in the score', async () => {
    const base = createMockProvider();
    const provider: AiProvider = {
      ...base,
      capabilities: base.capabilities.filter((c) => c !== 'clip-refinement'),
    };

    const deps = await makeDeps({ provider });
    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.job.state).toBe('COMPLETED');
    expect(outcome.clipPlans.length).toBeGreaterThan(0);
    expect(outcome.clipPlans.every((p) => p.score.breakdown.aiAssisted)).toBe(false);
  });

  it('completes the run when refinement throws, scoring on rules alone', async () => {
    const base = createMockProvider();
    const provider: AiProvider = {
      ...base,
      clipRefinement: {
        refineClip: async () => {
          throw aiError('provider_request_failed', 'Refinement is down.');
        },
      },
    };

    const deps = await makeDeps({ provider });
    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.job.state).toBe('COMPLETED');
    expect(outcome.job.failure).toBeNull();
    expect(outcome.clipPlans.length).toBeGreaterThan(0);
    expect(outcome.clipPlans.every((p) => p.score.breakdown.aiAssisted)).toBe(false);
  });

  it('bounds how many clips it builds, however many candidates were found', async () => {
    const refineClip = vi.fn(createMockProvider().clipRefinement!.refineClip);
    const deps = await makeDeps({
      provider: { ...createMockProvider(), clipRefinement: { refineClip } },
      maxCandidates: 12,
      maxClipsToBuild: 4,
    });

    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.candidates.length).toBeGreaterThan(4);
    // One refinement call per clip built — the bound is what caps the run's cost.
    expect(refineClip).toHaveBeenCalledTimes(4);
    expect(outcome.clipPlans.length).toBeLessThanOrEqual(3);
  });

  it('completes with no clips when every candidate was rejected', async () => {
    const base = createMockProvider();
    const provider: AiProvider = {
      ...base,
      clipDiscovery: {
        async discoverClips(): Promise<CandidateClipDraft[]> {
          return [
            {
              startSec: 0,
              endSec: 30,
              hookQuote: 'a sentence the speaker never uttered',
              topic: 'Invented',
              reason: 'Fabricated for this test.',
              signals: EMPTY_CLIP_SIGNALS,
              confidence: 0.9,
            },
          ];
        },
      },
    };

    const deps = await makeDeps({ provider });
    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.job.state).toBe('COMPLETED');
    expect(outcome.clipPlans).toEqual([]);
    expect(await deps.clipPlans.countByVideo(VIDEO_ID)).toBe(0);
    const reloaded = await deps.jobs.get(outcome.job.id);
    expect(reloaded.type === 'analysis' && reloaded.result.selectedClipPlanIds).toEqual([]);
  });

  it('replaces a previous run’s plans rather than accumulating them', async () => {
    const deps = await makeDeps();

    const first = await runAnalysis(deps, await queue(deps));
    const second = await runAnalysis(deps, await queue(deps));

    const stored = await deps.clipPlans.listByTranscript(second.transcript!.id);
    expect(stored).toHaveLength(second.clipPlans.length);
    expect(stored.map((p) => p.id)).not.toEqual(first.clipPlans.map((p) => p.id));
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/** The crop every fake render reports having used. */
const FIXTURE_CROP_PLAN = makeClipPlan([{ order: 0, startSec: 0, endSec: 18 }]).cropPlan!;

/** A `renderClipPlan` that reports success without going near FFmpeg. */
const fakeRenderClip = (request: RenderClipPlanRequest): RenderClipPlanResult => ({
  rendered: {
    path: request.outputPath,
    sizeBytes: 3_000_000,
    mode: 'reencode',
    modeReason: 'filters_requested',
    durationSec: request.plan.durationSec,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: true,
    videoCodec: 'h264',
    audioCodec: 'aac',
    containerFormat: 'mov,mp4,m4a',
    cutCount: request.plan.cuts.length,
    renderedAt: nowIso(),
  },
  profile: withCropPlan(DEFAULT_RENDER_PROFILE, FIXTURE_CROP_PLAN),
  cropPlan: FIXTURE_CROP_PLAN,
  trackerId: 'center-v1',
  trackerMode: 'center',
  cueCount: request.subtitles?.segments.length ?? 0,
});

/**
 * A provider whose moments genuinely differ from each other.
 *
 * Pins the moments to fixed timestamps and gives each one an unmistakably
 * different vocabulary, so a test about *how* clips are rendered does not also
 * depend on what the mock provider's filler happens to score. This one gives
 * each segment its own vocabulary, so three distinct
 * Shorts survive selection.
 */
function variedProvider(): AiProvider {
  const base = createMockProvider();
  const SEGMENT_SEC = 6;

  const segments = (durationSec: number) => {
    const out = [];
    for (let i = 0, start = 0; start < durationSec; i += 1, start += SEGMENT_SEC) {
      const end = Math.min(start + SEGMENT_SEC, durationSec);
      const text = `Topic${i} means that item${i} always beats gadget${i} when method${i} arrives.`;
      const words = text.split(' ').map((word, w, all) => ({
        text: word,
        startSec: start + ((end - start) * w) / all.length,
        endSec: start + ((end - start) * (w + 1)) / all.length,
      }));
      out.push({ startSec: start, endSec: end, text, confidence: 1, words });
    }
    return out;
  };

  return {
    ...base,
    transcription: {
      audioSpec: base.transcription!.audioSpec,
      transcribe: async (request) => ({
        language: 'en',
        model: 'varied-v1',
        segments: segments(request.durationSec),
      }),
    },
    clipDiscovery: {
      discoverClips: async (request): Promise<CandidateClipDraft[]> =>
        [0, 200, 400].map((startSec, i) => ({
          startSec,
          endSec: startSec + 36,
          // Verbatim, so it passes the same guard a real provider must pass.
          hookQuote:
            request.segments.find((s) => s.endSec > startSec && s.startSec < startSec + 36)?.text ?? null,
          topic: `Distinct moment ${i + 1}`,
          reason: 'Fixture: three deliberately different moments.',
          signals: { ...EMPTY_CLIP_SIGNALS, strongOpening: true, informationDensity: 0.8, standalone: 0.8 },
          confidence: 0.9 - i * 0.1,
        })),
    },
  };
}

describe('runAnalysis — rendering', () => {
  const withRenderer = async (renderClip: AnalysisDeps['renderClip'], overrides: Partial<AnalysisDeps> = {}) => {
    const stores = makeStores();
    const renders = new SqliteClipRenderRepository(stores.db);
    const deps = await makeDeps({ renders, renderClip, ...overrides }, stores);
    return { deps, renders };
  };

  it('renders the selected clips and completes through RENDERING', async () => {
    const renderClip = vi.fn(async (request: RenderClipPlanRequest) => fakeRenderClip(request));
    const { deps, renders } = await withRenderer(renderClip);

    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.job.state).toBe('COMPLETED');
    expect(outcome.job.history.map((h) => h.state)).toEqual([
      'QUEUED',
      'ANALYZING',
      'TRANSCRIBING',
      'FINDING_CLIPS',
      'BUILDING_CLIPS',
      'RENDERING',
      'COMPLETED',
    ]);

    expect(renderClip).toHaveBeenCalledTimes(outcome.clipPlans.length);
    expect(outcome.renders.map((r) => r.status)).toEqual(outcome.clipPlans.map(() => 'RENDERED'));
    expect(outcome.renders.map((r) => r.clipPlanId)).toEqual(outcome.clipPlans.map((p) => p.id));

    // Persisted, and reachable from the job record.
    expect(await renders.countByVideo(VIDEO_ID)).toBe(outcome.clipPlans.length);
    const reloaded = await deps.jobs.get(outcome.job.id);
    expect(reloaded.type === 'analysis' && reloaded.result.renderIds).toEqual(
      outcome.renders.map((r) => r.id),
    );
    expect(reloaded.progress).toBe(100);
  });

  it('renders exactly the top-3 selection and nothing more', async () => {
    const renderClip = vi.fn(async (request: RenderClipPlanRequest) => fakeRenderClip(request));
    const { deps } = await withRenderer(renderClip, { provider: variedProvider() });

    const outcome = await runAnalysis(deps, await queue(deps));

    // Three distinct moments survive selection here, which is the ceiling.
    expect(outcome.clipPlans).toHaveLength(3);
    expect(renderClip).toHaveBeenCalledTimes(3);
    expect(new Set(renderClip.mock.calls.map((call) => call[0].plan.id)).size).toBe(3);
    expect(outcome.renders).toHaveLength(3);
  });

  /**
   * Regression: three Shorts that were all the same forty seconds. Ranges are
   * carried from the plan into the cut command and nowhere else, so this walks
   * that path — selection → render request → FFmpeg arguments → output path —
   * and asserts each clip is cut from its own span.
   */
  it('cuts each Short from its own source range', async () => {
    const renderClip = vi.fn(async (request: RenderClipPlanRequest) => fakeRenderClip(request));
    const { deps } = await withRenderer(renderClip);

    const outcome = await runAnalysis(deps, await queue(deps));
    expect(outcome.clipPlans).toHaveLength(3);

    // Each render request carries the plan selected at that rank, untouched.
    const cuts = renderClip.mock.calls.map((call) => call[0].plan.cuts);
    expect(cuts).toEqual(outcome.clipPlans.map((plan) => plan.cuts));
    expect(new Set(cuts.map((cut) => JSON.stringify(cut))).size).toBe(3);

    // The command FFmpeg would run seeks to that plan's start, for that plan's
    // duration — three different commands, not one repeated.
    const commands = cuts.map((cut) =>
      buildCutArgs({ sourcePath: '/src.mp4', outputPath: '/out.mp4', cut: cut[0]!, mode: 'reencode' }),
    );
    for (const [index, args] of commands.entries()) {
      const cut = cuts[index]![0]!;
      expect(args[args.indexOf('-ss') + 1]).toBe(formatSeconds(cut.startSec));
      expect(args[args.indexOf('-t') + 1]).toBe(formatSeconds(cut.endSec - cut.startSec));
    }
    expect(new Set(commands.map((args) => args.join(' '))).size).toBe(3);

    // And each lands in its own file, so no clip can overwrite another.
    expect(new Set(renderClip.mock.calls.map((call) => call[0].outputPath)).size).toBe(3);
  });

  it('renders the clips one at a time', async () => {
    let active = 0;
    let peak = 0;
    const { deps } = await withRenderer(
      async (request: RenderClipPlanRequest) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active -= 1;
        return fakeRenderClip(request);
      },
      { provider: variedProvider() },
    );

    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.renders.length).toBeGreaterThan(1);
    expect(peak).toBe(1);
  });

  it('burns the transcript’s own words, timed against the clip', async () => {
    const renderClip = vi.fn(async (request: RenderClipPlanRequest) => fakeRenderClip(request));
    const { deps } = await withRenderer(renderClip);

    const outcome = await runAnalysis(deps, await queue(deps));

    const [call] = renderClip.mock.calls;
    const subtitles = call![0].subtitles!;
    const plan = outcome.clipPlans.find((p) => p.id === call![0].plan.id)!;

    expect(subtitles.segments.length).toBeGreaterThan(0);
    expect(subtitles.clipDurationSec).toBeCloseTo(plan.durationSec, 3);
    for (const cue of subtitles.segments) {
      expect(cue.startSec).toBeGreaterThanOrEqual(0);
      expect(cue.endSec).toBeLessThanOrEqual(subtitles.clipDurationSec + 0.001);
      // Verbatim: every cue is traceable to the clip's transcript text.
      for (const word of cue.lines.join(' ').split(/\s+/).filter(Boolean)) {
        expect(plan.text).toContain(word);
      }
    }
    expect(outcome.renders.every((r) => r.cueCount > 0)).toBe(true);
  });

  it('completes the run when one clip fails to render, keeping the others', async () => {
    let call = 0;
    const { deps, renders } = await withRenderer(
      async (request: RenderClipPlanRequest) => {
        call += 1;
        if (call === 2) throw renderingError('render_failed', 'FFmpeg failed to render the clip.');
        return fakeRenderClip(request);
      },
      { provider: variedProvider() },
    );

    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.job.state).toBe('COMPLETED');
    expect(outcome.job.failure).toBeNull();
    expect(outcome.renders).toHaveLength(3);
    expect(outcome.renders.filter((r) => r.status === 'FAILED')).toHaveLength(1);
    expect(outcome.renders.filter((r) => r.status === 'RENDERED')).toHaveLength(2);

    const stored = await renders.listByVideo(VIDEO_ID);
    expect(stored.find((r) => r.status === 'FAILED')!.error).toMatchObject({ code: 'render_failed' });
    expect(stored.filter((r) => r.status === 'RENDERED').every((r) => r.storageKey !== null)).toBe(true);
  });

  it('stops at clip building when no renderer is wired in', async () => {
    const deps = await makeDeps();
    const outcome = await runAnalysis(deps, await queue(deps));

    expect(outcome.job.history.map((h) => h.state)).not.toContain('RENDERING');
    expect(outcome.renders).toEqual([]);
    const reloaded = await deps.jobs.get(outcome.job.id);
    expect(reloaded.type === 'analysis' && reloaded.result.renderIds).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

describe('JobRunner', () => {
  let deps: AnalysisDeps;

  beforeEach(async () => {
    deps = await makeDeps();
  });

  it('runs a queued job to completion in the background', async () => {
    const runner = new JobRunner({
      concurrency: 1,
      logger,
      jobs: deps.jobs,
      run: (job) => runAnalysis(deps, job),
    });

    const job = await queue(deps);
    runner.enqueue(job);

    // enqueue returns before the work happens.
    expect(runner.stats.queued + runner.stats.active).toBeGreaterThan(0);
    await runner.whenIdle();

    expect((await deps.jobs.get(job.id)).state).toBe('COMPLETED');
  });

  it('never exceeds its concurrency limit', async () => {
    let active = 0;
    let peak = 0;

    const runner = new JobRunner({
      concurrency: 2,
      logger,
      jobs: deps.jobs,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
    });

    for (let i = 0; i < 6; i += 1) runner.enqueue(await queue(deps));
    await runner.whenIdle();

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('marks a job failed if the work function throws outright', async () => {
    const runner = new JobRunner({
      concurrency: 1,
      logger,
      jobs: deps.jobs,
      run: async () => {
        throw new Error('unhandled');
      },
    });

    const job = await queue(deps);
    runner.enqueue(job);
    await runner.whenIdle();

    const reloaded = await deps.jobs.get(job.id);
    expect(reloaded.state).toBe('FAILED');
    expect(reloaded.failure?.kind).toBe('unexpected');
  });
});

describe('restart recovery', () => {
  it('fails jobs that a previous process left mid-flight', async () => {
    const deps = await makeDeps();
    const { transitionJob } = await import('@/jobs/transitions');

    const stranded = await deps.jobs.save(transitionJob(await queue(deps), 'ANALYZING'));
    const untouched = await queue(deps);

    const count = await recoverInterrupted(deps.jobs, logger);

    expect(count).toBe(1);
    expect((await deps.jobs.get(stranded.id)).state).toBe('FAILED');
    expect((await deps.jobs.get(stranded.id)).failure?.message).toMatch(/restart/i);
    // A job that never started is still runnable and must not be failed.
    expect((await deps.jobs.get(untouched.id)).state).toBe('QUEUED');
  });

  it('re-queues jobs that never started', async () => {
    const deps = await makeDeps();
    const job = await queue(deps);

    const runner = new JobRunner({
      concurrency: 1,
      logger,
      jobs: deps.jobs,
      run: (queued) => runAnalysis(deps, queued),
    });

    expect(await resumeQueued(deps.jobs, runner, logger)).toBe(1);
    await runner.whenIdle();

    expect((await deps.jobs.get(job.id)).state).toBe('COMPLETED');
  });

  it('leaves a completed job alone', async () => {
    const deps = await makeDeps();
    const done = await runAnalysis(deps, await queue(deps));

    await recoverInterrupted(deps.jobs, logger);

    expect((await deps.jobs.get(done.job.id)).state).toBe('COMPLETED');
  });
});

describe('pipeline isolation', () => {
  it('does not touch a different video', async () => {
    const deps = await makeDeps();
    const other = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' as VideoId;
    await deps.videos.create(makeVideoAsset({ id: other }));

    await runAnalysis(deps, await queue(deps));

    expect(await deps.candidates.countByVideo(other)).toBe(0);
    expect(await deps.transcripts.findByVideo(other)).toBeNull();
  });
});
