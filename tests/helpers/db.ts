/** Test database helpers. Every test gets a private in-memory schema. */

import { openDatabase, type Database } from '@/storage/db';
import { SqliteVideoRepository } from '@/storage/video-repository';
import { SqliteTranscriptRepository } from '@/storage/transcript-repository';
import { SqliteCandidateRepository } from '@/storage/candidate-repository';
import { SqliteClipPlanRepository } from '@/storage/clip-plan-repository';
import { SqliteClipRenderRepository } from '@/storage/clip-render-repository';
import { SqliteJobStore } from '@/jobs/store';

export interface TestStores {
  readonly db: Database;
  readonly videos: SqliteVideoRepository;
  readonly transcripts: SqliteTranscriptRepository;
  readonly candidates: SqliteCandidateRepository;
  readonly clipPlans: SqliteClipPlanRepository;
  readonly clipRenders: SqliteClipRenderRepository;
  readonly jobs: SqliteJobStore;
}

export function makeStores(db: Database = openDatabase(':memory:')): TestStores {
  return {
    db,
    videos: new SqliteVideoRepository(db),
    transcripts: new SqliteTranscriptRepository(db),
    candidates: new SqliteCandidateRepository(db),
    clipPlans: new SqliteClipPlanRepository(db),
    clipRenders: new SqliteClipRenderRepository(db),
    jobs: new SqliteJobStore(db),
  };
}

/** Deterministic id sequence, so persisted records are assertable. */
export function sequentialIds(prefix = 'id'): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${String(n).padStart(4, '0')}`;
  };
}
