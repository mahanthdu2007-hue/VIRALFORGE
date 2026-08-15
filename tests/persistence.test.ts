import { afterEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, SCHEMA_VERSION } from '@/storage/db';
import { buildTranscript, SqliteTranscriptRepository } from '@/storage/transcript-repository';
import { buildCandidates, SqliteCandidateRepository } from '@/storage/candidate-repository';
import { buildClipPlans } from '@/storage/clip-plan-repository';
import { SqliteVideoRepository } from '@/storage/video-repository';
import { SqliteJobStore, createAnalysisJob } from '@/jobs/store';
import { transitionJob } from '@/jobs/transitions';
import { scoreClip, type ClipPlanDraft } from '@/clips';
import { makeStores, sequentialIds } from './helpers/db';
import { makeVideoAsset, VIDEO_ID } from './helpers/fixtures';
import {
  EMPTY_CLIP_SIGNALS,
  nowIso,
  type CandidateClipId,
  type ClipPlanId,
  type TranscriptId,
} from '@/domain';
import type { NormalisedTranscript } from '@/validation/transcript';
import type { AcceptedCandidate } from '@/validation/candidates';

const normalised: NormalisedTranscript = {
  language: 'en',
  model: 'test-model',
  notes: [],
  segments: [
    {
      startSec: 0,
      endSec: 5,
      text: 'I thought it would take a year.',
      confidence: 0.91,
      speaker: 'SPEAKER_00',
      words: [
        { text: 'I', startSec: 0, endSec: 0.4 },
        { text: 'thought', startSec: 0.4, endSec: 1.1 },
      ],
    },
    { startSec: 5, endSec: 11, text: 'It took three weeks.', confidence: null, speaker: null, words: null },
  ],
};

const accepted: AcceptedCandidate[] = [
  {
    startSec: 0,
    endSec: 30,
    text: 'I thought it would take a year. It took three weeks.',
    segmentIds: [],
    hookQuote: 'I thought it would take a year',
    topic: 'Faster than expected',
    reason: 'Expectation set and broken.',
    signals: { ...EMPTY_CLIP_SIGNALS, surprise: true, standalone: 0.9 },
    confidence: 0.85,
  },
];

describe('schema', () => {
  it('migrates a fresh database to the current version', () => {
    const db = openDatabase(':memory:');
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };

    expect(row.user_version).toBe(SCHEMA_VERSION);
  });

  it('is idempotent when opened twice', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-db-'));
    const file = path.join(dir, 'test.db');

    openDatabase(file).close();
    const second = openDatabase(file);
    const row = second.prepare('PRAGMA user_version').get() as { user_version: number };

    expect(row.user_version).toBe(SCHEMA_VERSION);
    second.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('enforces the foreign key from jobs to videos', async () => {
    const { jobs } = makeStores();
    // The video was never created, so the job must not be storable.
    await expect(jobs.create(createAnalysisJob(VIDEO_ID))).rejects.toThrow();
  });
});

describe('transcript persistence', () => {
  it('round-trips segments, words, confidence and speaker', async () => {
    const { videos, transcripts } = makeStores();
    await videos.create(makeVideoAsset());

    const built = buildTranscript(normalised, VIDEO_ID, 'mock', sequentialIds('t'));
    await transcripts.save(built);

    const loaded = await transcripts.get(built.id);
    expect(loaded).toEqual(built);
    expect(loaded.segments).toHaveLength(2);
    expect(loaded.segments[0]!.words).toHaveLength(2);
    expect(loaded.segments[0]!.confidence).toBe(0.91);
    expect(loaded.segments[0]!.speaker).toBe('SPEAKER_00');
    expect(loaded.segments[1]!.words).toBeNull();
    expect(loaded.segments[1]!.confidence).toBeNull();
  });

  it('assigns identifiers rather than letting the provider mint them', () => {
    const built = buildTranscript(normalised, VIDEO_ID, 'mock', sequentialIds('t'));

    expect(built.id).toBe('t-0001');
    expect(built.segments.map((s) => s.id)).toEqual(['t-0002', 't-0003']);
    expect(built.segments.map((s) => s.index)).toEqual([0, 1]);
    expect(built.source).toEqual({ provider: 'mock', model: 'test-model' });
  });

  it('preserves segment order on reload', async () => {
    const { videos, transcripts } = makeStores();
    await videos.create(makeVideoAsset());

    const built = buildTranscript(normalised, VIDEO_ID, 'mock', sequentialIds('t'));
    await transcripts.save(built);

    expect((await transcripts.get(built.id)).segments.map((s) => s.startSec)).toEqual([0, 5]);
  });

  it('replaces the segments wholesale when re-saved', async () => {
    const { videos, transcripts, db } = makeStores();
    await videos.create(makeVideoAsset());

    const built = buildTranscript(normalised, VIDEO_ID, 'mock', sequentialIds('t'));
    await transcripts.save(built);
    await transcripts.save({ ...built, segments: [built.segments[0]!] });

    const count = db.prepare('SELECT COUNT(*) AS n FROM transcript_segments').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('finds the latest transcript for a video, and null when there is none', async () => {
    const { videos, transcripts } = makeStores();
    await videos.create(makeVideoAsset());

    expect(await transcripts.findByVideo(VIDEO_ID)).toBeNull();

    const built = buildTranscript(normalised, VIDEO_ID, 'mock', sequentialIds('t'));
    await transcripts.save(built);

    expect((await transcripts.findByVideo(VIDEO_ID))?.id).toBe(built.id);
  });

  it('throws not_found for an unknown transcript', async () => {
    const { transcripts } = makeStores();
    await expect(transcripts.get('missing' as TranscriptId)).rejects.toMatchObject({
      kind: 'not_found',
      code: 'transcript_not_found',
    });
  });
});

describe('candidate persistence', () => {
  const seed = async () => {
    const stores = makeStores();
    await stores.videos.create(makeVideoAsset());
    const transcript = buildTranscript(normalised, VIDEO_ID, 'mock', sequentialIds('t'));
    await stores.transcripts.save(transcript);
    return { ...stores, transcript };
  };

  it('round-trips signals, quote and null score', async () => {
    const { candidates, transcript } = await seed();

    const built = buildCandidates(accepted, VIDEO_ID, transcript.id, sequentialIds('c'));
    await candidates.saveMany(built, transcript.id);

    const loaded = await candidates.listByVideo(VIDEO_ID);
    expect(loaded).toEqual(built);
    expect(loaded[0]!.signals.surprise).toBe(true);
    expect(loaded[0]!.hookQuote).toBe('I thought it would take a year');
    // Scoring is a later phase; discovery must not pretend to have run it.
    expect(loaded[0]!.score).toBeNull();
    expect(loaded[0]!.confidence).toBe(0.85);
  });

  it('counts candidates for a video', async () => {
    const { candidates, transcript } = await seed();
    expect(await candidates.countByVideo(VIDEO_ID)).toBe(0);

    await candidates.saveMany(buildCandidates(accepted, VIDEO_ID, transcript.id, sequentialIds('c')), transcript.id);
    expect(await candidates.countByVideo(VIDEO_ID)).toBe(1);
  });

  it('replaces a previous discovery run for the same transcript', async () => {
    const { candidates, transcript } = await seed();

    await candidates.saveMany(buildCandidates(accepted, VIDEO_ID, transcript.id, sequentialIds('a')), transcript.id);
    await candidates.saveMany(buildCandidates(accepted, VIDEO_ID, transcript.id, sequentialIds('b')), transcript.id);

    const loaded = await candidates.listByTranscript(transcript.id);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe('b-0001');
  });

  it('orders candidates along the source timeline', async () => {
    const { candidates, transcript } = await seed();
    const two: AcceptedCandidate[] = [
      { ...accepted[0]!, startSec: 40, endSec: 70 },
      { ...accepted[0]!, startSec: 0, endSec: 30 },
    ];

    await candidates.saveMany(buildCandidates(two, VIDEO_ID, transcript.id, sequentialIds('c')), transcript.id);

    expect((await candidates.listByVideo(VIDEO_ID)).map((c) => c.startSec)).toEqual([0, 40]);
  });
});

describe('clip plan repository', () => {
  /** Seeds a video, transcript and one candidate, then plans built from it. */
  const seedPlans = async () => {
    const stores = makeStores();
    await stores.videos.create(makeVideoAsset());

    const transcript = buildTranscript(normalised, VIDEO_ID, 'mock', sequentialIds('t'));
    await stores.transcripts.save(transcript);

    const candidates = await stores.candidates.saveMany(
      buildCandidates(accepted, VIDEO_ID, transcript.id, sequentialIds('c')),
      transcript.id,
    );

    return { ...stores, transcript, candidate: candidates[0]! };
  };

  const makeDraft = (
    candidate: { id: CandidateClipId; transcriptId: TranscriptId },
    overrides: Partial<ClipPlanDraft> = {},
  ): ClipPlanDraft => ({
    candidateClipId: candidate.id,
    videoId: VIDEO_ID,
    transcriptId: candidate.transcriptId,
    cuts: [{ order: 0, startSec: 0, endSec: 35 }],
    startSec: 0,
    endSec: 35,
    durationSec: 35,
    text: 'I thought it would take a year. It took three weeks.',
    hookQuote: 'I thought it would take a year',
    topic: 'Faster than expected',
    title: 'Faster than expected',
    segmentIds: [],
    boundaries: {
      startSnap: 'word',
      endSnap: 'segment',
      startsOnSentence: true,
      endsOnSentence: true,
      startShiftSec: 0,
      endShiftSec: 0.5,
      notes: ['snapped_to_segment_end'],
    },
    speech: { wordCount: 11, wordsPerSecond: 2.4, maxGapSec: 0.2 },
    signals: { ...EMPTY_CLIP_SIGNALS, surprise: true, standalone: 0.9 },
    semantic: null,
    createdAt: nowIso(),
    ...overrides,
  });

  const score = (draft: ClipPlanDraft) =>
    scoreClip({
      text: draft.text,
      durationSec: draft.durationSec,
      signals: draft.signals,
      boundaries: draft.boundaries,
      speech: draft.speech,
      hookQuote: draft.hookQuote,
      semantic: draft.semantic,
    });

  it('round-trips a plan whole, including its score breakdown', async () => {
    const { clipPlans, transcript, candidate } = await seedPlans();

    const draft = makeDraft(candidate);
    const built = buildClipPlans([{ draft, score: score(draft), rank: 1 }], sequentialIds('p'));
    await clipPlans.saveMany(built, transcript.id);

    const loaded = await clipPlans.listByVideo(VIDEO_ID);
    expect(loaded).toEqual(built);

    // The breakdown is what makes a ranking explainable after the fact, so it
    // has to survive the JSON round-trip intact — weights included.
    const stored = loaded[0]!;
    expect(stored.score.breakdown.weights.components.hook).toBe(
      built[0]!.score.breakdown.weights.components.hook,
    );
    expect(stored.score.rationale).toBe(built[0]!.score.rationale);
    expect(stored.boundaries.notes).toEqual(['snapped_to_segment_end']);
    expect(stored.hookQuote).toBe('I thought it would take a year');
  });

  it('leaves rendering inputs empty, because those phases have not run', async () => {
    const { clipPlans, transcript, candidate } = await seedPlans();

    const draft = makeDraft(candidate);
    await clipPlans.saveMany(
      buildClipPlans([{ draft, score: score(draft), rank: 1 }], sequentialIds('p')),
      transcript.id,
    );

    const [stored] = await clipPlans.listByVideo(VIDEO_ID);
    expect(stored!.cropPlan).toBeNull();
    expect(stored!.subtitles).toEqual([]);
  });

  it('reads plans back in rank order, not insertion order', async () => {
    const { clipPlans, transcript, candidate } = await seedPlans();

    const first = makeDraft(candidate);
    const second = makeDraft(candidate, { startSec: 60, endSec: 95, cuts: [{ order: 0, startSec: 60, endSec: 95 }] });

    await clipPlans.saveMany(
      buildClipPlans(
        [
          { draft: second, score: score(second), rank: 2 },
          { draft: first, score: score(first), rank: 1 },
        ],
        sequentialIds('p'),
      ),
      transcript.id,
    );

    expect((await clipPlans.listByVideo(VIDEO_ID)).map((p) => p.rank)).toEqual([1, 2]);
    expect((await clipPlans.listByTranscript(transcript.id)).map((p) => p.cuts[0]!.startSec)).toEqual([0, 60]);
  });

  it('replaces a previous run for the same transcript, and counts by video', async () => {
    const { clipPlans, transcript, candidate } = await seedPlans();
    expect(await clipPlans.countByVideo(VIDEO_ID)).toBe(0);

    const draft = makeDraft(candidate);
    const entry = { draft, score: score(draft), rank: 1 };

    await clipPlans.saveMany(buildClipPlans([entry], sequentialIds('a')), transcript.id);
    await clipPlans.saveMany(buildClipPlans([entry], sequentialIds('b')), transcript.id);

    expect(await clipPlans.countByVideo(VIDEO_ID)).toBe(1);
    expect((await clipPlans.listByTranscript(transcript.id))[0]!.id).toBe('b-0001');
  });

  it('finds a single plan by id, and returns null for one that does not exist', async () => {
    const { clipPlans, transcript, candidate } = await seedPlans();

    const draft = makeDraft(candidate);
    const built = buildClipPlans([{ draft, score: score(draft), rank: 1 }], sequentialIds('p'));
    await clipPlans.saveMany(built, transcript.id);

    expect((await clipPlans.find(built[0]!.id))?.title).toBe('Faster than expected');
    expect(await clipPlans.find('nope' as ClipPlanId)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Restart behaviour — the whole point of moving off in-memory storage.        */
/* -------------------------------------------------------------------------- */

describe('durability across a restart', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  });

  it('keeps videos, jobs, transcripts and candidates after reopening the file', async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-restart-'));
    const file = path.join(dir, 'viralforge.db');

    // --- first "process" ---
    const first = openDatabase(file);
    const videos = new SqliteVideoRepository(first);
    const transcripts = new SqliteTranscriptRepository(first);
    const candidateRepo = new SqliteCandidateRepository(first);
    const jobs = new SqliteJobStore(first);

    await videos.create(makeVideoAsset());
    const transcript = buildTranscript(normalised, VIDEO_ID, 'mock', sequentialIds('t'));
    await transcripts.save(transcript);
    await candidateRepo.saveMany(
      buildCandidates(accepted, VIDEO_ID, transcript.id, sequentialIds('c')),
      transcript.id,
    );

    const job = await jobs.create(createAnalysisJob(VIDEO_ID));
    await jobs.save({
      ...transitionJob(job, 'ANALYZING'),
      result: {
        transcriptId: transcript.id,
        candidateClipIds: ['c-0001' as never],
        selectedClipPlanIds: [],
        renderIds: [],
      },
    });

    first.close();

    // --- second "process" ---
    const second = openDatabase(file);
    const reopened = {
      videos: new SqliteVideoRepository(second),
      transcripts: new SqliteTranscriptRepository(second),
      candidates: new SqliteCandidateRepository(second),
      jobs: new SqliteJobStore(second),
    };

    expect((await reopened.videos.get(VIDEO_ID)).originalFilename).toBe('talk.mp4');
    expect((await reopened.transcripts.get(transcript.id)).segments).toHaveLength(2);
    expect(await reopened.candidates.countByVideo(VIDEO_ID)).toBe(1);

    const loadedJob = await reopened.jobs.get(job.id);
    expect(loadedJob.state).toBe('ANALYZING');
    expect(loadedJob.type === 'analysis' && loadedJob.result.transcriptId).toBe(transcript.id);

    second.close();
  });
});
