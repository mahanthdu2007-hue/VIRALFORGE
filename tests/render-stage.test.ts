/**
 * The render stage's orchestration, with the renderer itself faked.
 *
 * What is under test here is the wiring and the promises the stage makes about
 * it — sequencing, the top-3 bound, per-clip persistence, isolation of a failed
 * clip, and the verbatim guard on cues. The FFmpeg half is proved separately by
 * `render-pipeline-e2e.test.ts` against a real file.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildClipSubtitles,
  MAX_RENDERED_CLIPS,
  renderSelectedClips,
  renderStorageKey,
  type RenderClipFn,
  type RenderStageDeps,
} from '@/pipeline/render-stage';
import { SqliteClipRenderRepository } from '@/storage/clip-render-repository';
import { DEFAULT_RENDER_PROFILE } from '@/media/clip-render';
import { withCropPlan } from '@/media/reframe';
import { createLogger } from '@/lib/logger';
import { renderingError } from '@/lib/errors';
import {
  EMPTY_CLIP_SIGNALS,
  nowIso,
  subtitlePlanText,
  type CandidateClip,
  type CandidateClipId,
  type ClipPlan,
  type ClipPlanId,
  type Transcript,
} from '@/domain';
import type { RenderClipPlanRequest, RenderClipPlanResult } from '@/pipeline/render-clip';
import type { FileStore } from '@/storage/file-store';
import { makeClipPlan, makeTranscript, makeVideoAsset, VIDEO_ID } from './helpers/fixtures';
import { makeStores, sequentialIds, type TestStores } from './helpers/db';

const logger = createLogger({ level: 'error', sink: () => {} });

const SPEECH = [
  { startSec: 0, endSec: 6, text: 'We tried the obvious thing first and it did not work at all.' },
  { startSec: 6, endSec: 12, text: 'So we stopped, and asked what the machine was actually waiting for.' },
  { startSec: 12, endSec: 18, text: 'It was waiting on a lock nobody had thought about in two years.' },
  { startSec: 18, endSec: 24, text: 'We removed it, and the whole pipeline got four times faster.' },
  { startSec: 24, endSec: 30, text: 'That is the part nobody expected, and it cost us one line.' },
];

const transcript: Transcript = makeTranscript(SPEECH);

/** Verbatim text for a range, exactly as the transcript spells it. */
const speechBetween = (startSec: number, endSec: number): string =>
  SPEECH.filter((s) => s.endSec > startSec && s.startSec < endSec)
    .map((s) => s.text)
    .join(' ');

const planFor = (id: string, rank: number, startSec: number, endSec: number): ClipPlan =>
  makeClipPlan([{ order: 0, startSec, endSec }], {
    id: id as ClipPlanId,
    rank,
    text: speechBetween(startSec, endSec),
    hookQuote: null,
    cropPlan: null,
  });

const fakeFiles = (): FileStore => ({
  init: async () => {},
  absolutePath: (key: string) => `/storage/${key}`,
  exists: async () => true,
  stat: async () => null,
  remove: async () => {},
  writeStream: async () => ({ key: 'uploads/x', sizeBytes: 0 }),
});

/** The crop every fake render reports having used. */
const FIXTURE_CROP_PLAN = makeClipPlan([{ order: 0, startSec: 0, endSec: 18 }]).cropPlan!;

/** What a successful `renderClipPlan` returns, without running FFmpeg. */
const renderedResult = (request: RenderClipPlanRequest): RenderClipPlanResult => ({
  rendered: {
    path: request.outputPath,
    sizeBytes: 4_200_000,
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
  trackerId: 'fake-tracker',
  trackerMode: 'center',
  cueCount: request.subtitles?.segments.length ?? 0,
});

interface Harness {
  readonly deps: RenderStageDeps;
  readonly renders: SqliteClipRenderRepository;
  readonly stores: TestStores;
}

/**
 * Real repositories on an in-memory database: the promise being tested is that
 * each clip's outcome *survives* independently, and only the actual SQLite
 * writes — foreign keys included — prove that.
 */
async function harness(renderClip: RenderClipFn, plans: readonly ClipPlan[]): Promise<Harness> {
  const stores = makeStores();

  await stores.videos.create(makeVideoAsset());
  await stores.transcripts.save(transcript);
  await stores.candidates.saveMany([candidateFor(plans)], transcript.id);
  await stores.clipPlans.saveMany(plans, transcript.id);

  const renders = new SqliteClipRenderRepository(stores.db);

  return {
    stores,
    renders,
    deps: {
      logger,
      files: fakeFiles(),
      renders,
      renderClip,
      newId: sequentialIds('render'),
    },
  };
}

/** The one candidate row every fixture plan hangs off. */
const candidateFor = (plans: readonly ClipPlan[]): CandidateClip => ({
  id: (plans[0]?.candidateClipId ?? 'cand-1') as CandidateClipId,
  videoId: VIDEO_ID,
  transcriptId: transcript.id,
  startSec: 0,
  endSec: 30,
  text: speechBetween(0, 30),
  hookQuote: null,
  topic: null,
  reason: 'fixture candidate',
  signals: EMPTY_CLIP_SIGNALS,
  confidence: 0.9,
  score: null,
  segmentIds: transcript.segments.map((s) => s.id),
  createdAt: nowIso(),
});

const stageInput = (plans: readonly ClipPlan[]) => ({
  video: makeVideoAsset(),
  transcript,
  plans,
});

/* -------------------------------------------------------------------------- */

describe('renderSelectedClips', () => {
  it('renders every selected clip and records what each produced', async () => {
    const plans = [planFor('plan-a', 1, 0, 18), planFor('plan-b', 2, 12, 30)];
    const renderClip = vi.fn(async (request: RenderClipPlanRequest) => renderedResult(request));
    const { deps, renders } = await harness(renderClip, plans);

    const records = await renderSelectedClips(deps, stageInput(plans));

    expect(renderClip).toHaveBeenCalledTimes(2);
    expect(records.map((r) => r.status)).toEqual(['RENDERED', 'RENDERED']);
    expect(records.map((r) => r.clipPlanId)).toEqual(['plan-a', 'plan-b']);

    for (const record of records) {
      expect(record.storageKey).toBe(`renders/${record.clipPlanId}.mp4`);
      expect(record.width).toBe(1080);
      expect(record.height).toBe(1920);
      expect(record.durationSec).toBeGreaterThan(0);
      expect(record.sizeBytes).toBeGreaterThan(0);
      expect(record.error).toBeNull();
      expect(record.trackerId).toBe('fake-tracker');
    }

    // Persisted, not just returned.
    expect(await renders.countByVideo(VIDEO_ID)).toBe(2);
    expect(await renders.findByClipPlan('plan-a' as ClipPlanId)).toMatchObject({
      status: 'RENDERED',
      storageKey: 'renders/plan-a.mp4',
      hasAudio: true,
    });
  });

  it('renders one clip at a time, never several at once', async () => {
    const plans = [planFor('plan-a', 1, 0, 18), planFor('plan-b', 2, 12, 30), planFor('plan-c', 3, 0, 24)];
    let active = 0;
    let peak = 0;

    const { deps } = await harness(async (request) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return renderedResult(request);
    }, plans);

    await renderSelectedClips(deps, stageInput(plans));

    expect(peak).toBe(1);
  });

  it('never renders more than the top three, whatever it is handed', async () => {
    const plans = [
      planFor('plan-a', 1, 0, 18),
      planFor('plan-b', 2, 6, 24),
      planFor('plan-c', 3, 12, 30),
      planFor('plan-d', 4, 0, 24),
      planFor('plan-e', 5, 6, 30),
    ];
    const renderClip = vi.fn(async (request: RenderClipPlanRequest) => renderedResult(request));
    const { deps } = await harness(renderClip, plans);

    const records = await renderSelectedClips(deps, stageInput(plans));

    expect(MAX_RENDERED_CLIPS).toBe(3);
    expect(renderClip).toHaveBeenCalledTimes(3);
    expect(records.map((r) => r.clipPlanId)).toEqual(['plan-a', 'plan-b', 'plan-c']);
  });

  it('keeps the clips that worked when one fails, and records why', async () => {
    const plans = [planFor('plan-a', 1, 0, 18), planFor('plan-b', 2, 6, 24), planFor('plan-c', 3, 12, 30)];

    const { deps, renders } = await harness(async (request) => {
      if (request.plan.id === 'plan-b') {
        throw renderingError('render_failed', 'FFmpeg failed to render the clip.');
      }
      return renderedResult(request);
    }, plans);

    const records = await renderSelectedClips(deps, stageInput(plans));

    expect(records.map((r) => r.status)).toEqual(['RENDERED', 'FAILED', 'RENDERED']);

    const failed = records[1]!;
    expect(failed.error).toMatchObject({ kind: 'rendering', code: 'render_failed' });
    expect(failed.storageKey).toBeNull();
    expect(failed.durationSec).toBeNull();

    // The successes are intact in the store, not rolled back with the failure.
    const stored = await renders.listByVideo(VIDEO_ID);
    expect(stored.filter((r) => r.status === 'RENDERED')).toHaveLength(2);
    expect(stored.filter((r) => r.status === 'FAILED')).toHaveLength(1);
  });

  it('reports progress after each clip', async () => {
    const plans = [planFor('plan-a', 1, 0, 18), planFor('plan-b', 2, 12, 30)];
    const seen: [number, number][] = [];
    const { deps } = await harness(async (request) => renderedResult(request), plans);

    await renderSelectedClips(deps, {
      ...stageInput(plans),
      onProgress: (done, total) => {
        seen.push([done, total]);
      },
    });

    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('replaces a previous render of the same plan rather than accumulating rows', async () => {
    const plans = [planFor('plan-a', 1, 0, 18)];
    const { deps, renders } = await harness(async (request) => renderedResult(request), plans);

    await renderSelectedClips(deps, stageInput(plans));
    await renderSelectedClips(deps, stageInput(plans));

    expect(await renders.countByVideo(VIDEO_ID)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Subtitles                                                                  */
/* -------------------------------------------------------------------------- */

describe('render stage subtitles', () => {
  it('hands the renderer cues carrying the transcript’s own wording', async () => {
    const plans = [planFor('plan-a', 1, 0, 18)];
    const renderClip = vi.fn(async (request: RenderClipPlanRequest) => renderedResult(request));
    const { deps } = await harness(renderClip, plans);

    await renderSelectedClips(deps, stageInput(plans));

    const passed = renderClip.mock.calls[0]![0].subtitles!;
    expect(passed.segments.length).toBeGreaterThan(0);

    // Verbatim: every word burned in appears in the clip's transcript text.
    const burned = subtitlePlanText(passed.segments);
    for (const word of burned.split(/\s+/).filter(Boolean)) {
      expect(plans[0]!.text).toContain(word);
    }

    // Timed against the clip, never past its runtime.
    expect(passed.clipDurationSec).toBeCloseTo(plans[0]!.durationSec, 5);
    expect(Math.max(...passed.segments.map((s) => s.endSec))).toBeLessThanOrEqual(
      passed.clipDurationSec + 0.001,
    );
    expect(Math.min(...passed.segments.map((s) => s.startSec))).toBeGreaterThanOrEqual(0);
    // Laid out for the output frame the crop produces.
    expect(passed.layout.output).toEqual({ width: 1080, height: 1920 });
  });

  it('maps cues onto the clip timeline for a cut that starts late in the source', async () => {
    const plans = [planFor('plan-late', 1, 12, 30)];
    const renderClip = vi.fn(async (request: RenderClipPlanRequest) => renderedResult(request));
    const { deps } = await harness(renderClip, plans);

    await renderSelectedClips(deps, stageInput(plans));

    const passed = renderClip.mock.calls[0]![0].subtitles!;
    const text = subtitlePlanText(passed.segments);

    expect(passed.segments[0]!.startSec).toBeLessThan(1);
    expect(text).toContain('lock');
    // Nothing from before the cut leaked in.
    expect(text).not.toContain('obvious');
  });

  it('drops cues that are not traceable to the clip’s transcript text', () => {
    const forged = makeClipPlan([{ order: 0, startSec: 0, endSec: 18 }], {
      id: 'plan-forged' as ClipPlanId,
      // Not what the transcript says: the guard must refuse to burn these cues
      // rather than trusting their timings.
      text: 'Buy my course today and unlock the secret nobody will tell you.',
      hookQuote: null,
    });

    const warn = vi.fn();
    const result = buildClipSubtitles(forged, transcript, { debug: vi.fn(), warn });

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('renders the clip anyway when there are no usable cues', async () => {
    const silent = makeClipPlan([{ order: 0, startSec: 0, endSec: 18 }], {
      id: 'plan-silent' as ClipPlanId,
      text: 'nothing here matches the transcript',
      hookQuote: null,
    });
    const renderClip = vi.fn(async (request: RenderClipPlanRequest) => renderedResult(request));
    const { deps } = await harness(renderClip, [silent]);

    const records = await renderSelectedClips(deps, stageInput([silent]));

    expect(renderClip.mock.calls[0]![0].subtitles).toBeNull();
    expect(records[0]!.status).toBe('RENDERED');
    expect(records[0]!.cueCount).toBe(0);
  });
});

describe('renderStorageKey', () => {
  it('keeps renders in their own area, keyed by the plan', () => {
    expect(renderStorageKey({ id: 'plan-9' as ClipPlanId })).toBe('renders/plan-9.mp4');
  });
});
