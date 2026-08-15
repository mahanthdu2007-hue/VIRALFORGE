/**
 * Live investigation: why did the real 41:39 video (159 transcript segments)
 * produce 0 candidate moments from `nvidia/nemotron-3.5-lightning-30b-a3b`?
 *
 * Diagnostic only — gated behind `NVIDIA_LIVE_SMOKE=1`, never runs in `npm
 * test`. It replays the *exact* transcript that job `a35cc8bf-5142-4233-a9d6-
 * ec30fdec224c` persisted (read straight from `storage/viralforge.db`,
 * read-only) against the real NVIDIA endpoint, and prints:
 *
 *   1. The exact request body sent (model, prompt, transcript char length).
 *   2. The raw HTTP response — status, and the completion's raw `content`
 *      string — *before* any JSON.parse or Zod validation touches it.
 *   3. Whether `extractJsonContent`/`discoveryResponseSchema` accept it.
 *   4. If it parses: how many moments came back, and how `validateCandidates`
 *      disposes of each one (accepted vs. which rejection code).
 *
 * Run: NVIDIA_LIVE_SMOKE=1 npx vitest run tests/nvidia-discovery-live-investigation.test.ts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'vitest';
import { NVIDIA_BASE_URL } from '@/ai/providers/nvidia';
import { createNvidiaDiscovery } from '@/ai/providers/nvidia/discovery';
import { OpenAiClient } from '@/ai/providers/openai/client';
import { validateCandidates } from '@/validation/candidates';
import { CANDIDATE_MAX_DURATION_SEC, CANDIDATE_MIN_DURATION_SEC, nowIso } from '@/domain';
import type { Transcript, TranscriptId, TranscriptSegment, TranscriptSegmentId, TranscriptWord, VideoId } from '@/domain';

const LIVE = process.env.NVIDIA_LIVE_SMOKE === '1';

// The most recent COMPLETED analysis job with 159 segments / 0 candidates,
// found via `select id, video_id from jobs where state='COMPLETED' order by
// created_at desc` and cross-referenced against `transcripts`/`candidate_clips`.
const TRANSCRIPT_ID = 'c5574956-935b-4812-887b-205eb7d3eaf8';
const VIDEO_DURATION_SEC = 2499.001; // videos.metadata_json.durationSec for this job

function loadEnvLocal(): void {
  const envPath = path.resolve(import.meta.dirname, '..', '.env.local');
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

interface StoredSegmentRow {
  readonly idx: number;
  readonly start_sec: number;
  readonly end_sec: number;
  readonly text: string;
  readonly confidence: number | null;
  readonly speaker: string | null;
  readonly words_json: string;
}

function loadStoredSegments(): readonly TranscriptSegment[] {
  const dbPath = path.resolve(import.meta.dirname, '..', 'storage', 'viralforge.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        'select idx, start_sec, end_sec, text, confidence, speaker, words_json from transcript_segments where transcript_id = ? order by idx asc',
      )
      .all(TRANSCRIPT_ID) as unknown as StoredSegmentRow[];

    return rows.map((r): TranscriptSegment => ({
      id: `seg-${r.idx}` as TranscriptSegmentId,
      index: r.idx,
      startSec: r.start_sec,
      endSec: r.end_sec,
      text: r.text,
      confidence: r.confidence,
      speaker: r.speaker,
      words: (JSON.parse(r.words_json) as readonly TranscriptWord[]) ?? null,
    }));
  } finally {
    db.close();
  }
}

describe.skipIf(!LIVE)('NVIDIA discovery — live investigation of 0-candidate run', () => {
  it(
    'replays the exact stored transcript through discovery and prints the raw response',
    { timeout: 420_000 },
    async () => {
      loadEnvLocal();
      const segments = loadStoredSegments();
      console.log('Loaded stored segments:', segments.length);

      const transcriptChars = segments
        .map((s) => `[${s.startSec.toFixed(2)} - ${s.endSec.toFixed(2)}] ${s.text.trim()}`)
        .join('\n').length;
      console.log('Transcript char length sent to discovery:', transcriptChars);
      console.log('MAX_TRANSCRIPT_CHARS (discovery.ts):', 240_000, 'truncated:', transcriptChars > 240_000);

      const apiKey = (process.env.NVIDIA_API_KEY ?? '').trim();
      const model = (process.env.NVIDIA_DISCOVERY_MODEL ?? 'nvidia/nemotron-3.5-lightning-30b-a3b').trim();
      console.log('Model:', model);

      /* ---- Step 1: raw HTTP call, exactly what discovery.ts sends ---- */
      let capturedStatus: number | undefined;
      let capturedRawText: string | undefined;
      let capturedRawJson: unknown;

      const client = new OpenAiClient({
        apiKey,
        baseUrl: NVIDIA_BASE_URL,
        providerLabel: 'NVIDIA',
        fetchImpl: async (url, init) => {
          const response = await fetch(url, init);
          capturedStatus = response.status;
          const text = await response.clone().text();
          capturedRawText = text;
          try {
            capturedRawJson = JSON.parse(text);
          } catch {
            capturedRawJson = undefined;
          }
          return response;
        },
      });

      const discovery = createNvidiaDiscovery(client, model);

      let drafts: Awaited<ReturnType<typeof discovery.discoverClips>> = [];
      let discoveryError: unknown;
      try {
        drafts = await discovery.discoverClips({
          segments: segments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text })),
          videoDurationSec: VIDEO_DURATION_SEC,
          maxCandidates: 12,
          targetDurationSec: { min: CANDIDATE_MIN_DURATION_SEC, max: CANDIDATE_MAX_DURATION_SEC },
          languageHint: 'en-US',
        });
      } catch (error) {
        discoveryError = error;
      }

      console.log('\n=== HTTP status ===');
      console.log(capturedStatus);

      console.log('\n=== Raw completion object (top-level keys) ===');
      console.log(capturedRawJson && typeof capturedRawJson === 'object' ? Object.keys(capturedRawJson) : capturedRawJson);

      const choice = (capturedRawJson as { choices?: { message?: { content?: string }; finish_reason?: string }[] })
        ?.choices?.[0];
      console.log('\n=== finish_reason ===');
      console.log(choice?.finish_reason);

      console.log('\n=== Raw message.content (verbatim, before JSON.parse/Zod) ===');
      console.log(choice?.message?.content ?? '(no content field)');
      console.log('\n=== content length ===');
      console.log(choice?.message?.content?.length ?? 0);

      if (discoveryError) {
        console.log('\n=== discoverClips THREW ===');
        console.log(discoveryError);
      } else {
        console.log('\n=== discoverClips returned drafts ===');
        console.log('draft count:', drafts.length);
        console.log(JSON.stringify(drafts, null, 2));

        /* ---- Step 2: run the real drafts through the real validator ---- */
        const fakeTranscript: Transcript = {
          id: TRANSCRIPT_ID as TranscriptId,
          videoId: 'investigation' as VideoId,
          language: 'en-US',
          source: { provider: 'nvidia', model: 'nvidia/parakeet-tdt-0.6b-v2' },
          segments,
          createdAt: nowIso(),
        };

        const { accepted, rejected } = validateCandidates(drafts, fakeTranscript, VIDEO_DURATION_SEC);
        console.log('\n=== validateCandidates ===');
        console.log('accepted:', accepted.length);
        console.log('rejected:', rejected.length);
        for (const r of rejected) {
          console.log(' -', r.code, '|', r.reason, '| range', r.range);
        }
      }

      if (capturedRawText === undefined) {
        console.log('\n(no raw text captured — request may not have been sent)');
      }
    },
  );

  it(
    'checks whether latency scales with transcript size: same model, a 30-segment slice',
    { timeout: 420_000 },
    async () => {
      loadEnvLocal();
      const allSegments = loadStoredSegments();
      const segments = allSegments.slice(0, 30);

      const transcriptChars = segments
        .map((s) => `[${s.startSec.toFixed(2)} - ${s.endSec.toFixed(2)}] ${s.text.trim()}`)
        .join('\n').length;
      console.log('Slice: 30/', allSegments.length, 'segments,', transcriptChars, 'chars');

      const apiKey = (process.env.NVIDIA_API_KEY ?? '').trim();
      const model = (process.env.NVIDIA_DISCOVERY_MODEL ?? 'nvidia/nemotron-3.5-lightning-30b-a3b').trim();

      let capturedStatus: number | undefined;
      const client = new OpenAiClient({
        apiKey,
        baseUrl: NVIDIA_BASE_URL,
        providerLabel: 'NVIDIA',
        fetchImpl: async (url, init) => {
          const response = await fetch(url, init);
          capturedStatus = response.status;
          return response;
        },
      });

      const discovery = createNvidiaDiscovery(client, model);
      const startedAt = Date.now();
      let drafts: Awaited<ReturnType<typeof discovery.discoverClips>> = [];
      let discoveryError: unknown;
      try {
        drafts = await discovery.discoverClips({
          segments: segments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text })),
          videoDurationSec: VIDEO_DURATION_SEC,
          maxCandidates: 12,
          targetDurationSec: { min: CANDIDATE_MIN_DURATION_SEC, max: CANDIDATE_MAX_DURATION_SEC },
          languageHint: 'en-US',
        });
      } catch (error) {
        discoveryError = error;
      }
      const elapsedMs = Date.now() - startedAt;

      console.log('Elapsed:', elapsedMs, 'ms. HTTP status:', capturedStatus);
      if (discoveryError) {
        console.log('THREW:', discoveryError);
      } else {
        console.log('draft count:', drafts.length);
        console.log(JSON.stringify(drafts, null, 2));
      }
    },
  );
});
