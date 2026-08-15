/**
 * The whole pipeline, for real, on a generated MP4.
 *
 * One test, no API keys, no mocking below the AI provider: a synthetic source
 * video is written to a real file store, a real analysis job walks
 * ANALYZING → TRANSCRIBING → FINDING_CLIPS → BUILDING_CLIPS → RENDERING →
 * COMPLETED with FFmpeg doing the audio extraction and the encoding, and what
 * comes out the far end is inspected with ffprobe rather than trusted.
 *
 * The provider is a local fixture: it returns a deterministic transcript and
 * one deliberately-chosen moment. That is the *only* fake in the run — the
 * transcript's words are what the subtitle engine burns, so the verbatim
 * guarantee is exercised exactly as it would be against a real ASR.
 *
 * The claim that needs the most care is "the subtitles are actually there",
 * since ffprobe cannot see burned-in pixels. It is proved by rendering the same
 * plan a second time with captions switched off and comparing the caption band
 * of the same frame in both: the band must differ substantially while the top
 * of the frame, which no caption touches, stays essentially identical.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAnalysis } from '@/pipeline/analysis';
import { buildClipSubtitles, renderStorageKey } from '@/pipeline/render-stage';
import { renderClipPlan, type RenderClipPlanRequest } from '@/pipeline/render-clip';
import { SqliteClipRenderRepository } from '@/storage/clip-render-repository';
import { LocalFileStore } from '@/storage/file-store';
import { createAnalysisJob } from '@/jobs/store';
import { FfmpegMediaService } from '@/media/media-service';
import { runCommand } from '@/media/ffmpeg';
import { parseEnv } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { createMockProvider } from '@/ai/providers/mock';
import {
  EMPTY_CLIP_SIGNALS,
  nowIso,
  SHORTS_ASPECT_RATIO,
  type AnalysisJob,
  type VideoAsset,
} from '@/domain';
import type { AiProvider, CandidateClipDraft } from '@/ai/types';
import type { AnalysisDeps } from '@/pipeline/deps';
import { makeStores } from './helpers/db';
import { VIDEO_ID } from './helpers/fixtures';

const config = parseEnv(process.env, process.cwd());
const media = new FfmpegMediaService(config.media);
const logger = createLogger({ level: 'error', sink: () => {} });

const SOURCE_WIDTH = 1920;
const SOURCE_HEIGHT = 1080;
const SOURCE_DURATION_SEC = 30;
/** The moment the fixture provider "finds". Comfortably inside the source. */
const MOMENT = { startSec: 0, endSec: 24 };

const TRACKING = {
  mode: 'center' as const,
  modelPath: '',
  fps: 2,
  maxFrames: 240,
  maxEdgePx: 640,
  minConfidence: 0.6,
};

let workDir: string;
let storageRoot: string;
let sourceKey: string;
let toolchainAvailable = false;

beforeAll(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-e2e-'));
  storageRoot = path.join(workDir, 'storage');

  toolchainAvailable = (await media.toolchain()).available;
  if (!toolchainAvailable) return;

  const files = new LocalFileStore(storageRoot);
  await files.init();

  sourceKey = 'uploads/e2e-source.mp4';
  await runCommand(
    config.media.ffmpegPath,
    [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i',
      `testsrc2=size=${SOURCE_WIDTH}x${SOURCE_HEIGHT}:rate=25:duration=${SOURCE_DURATION_SEC}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SOURCE_DURATION_SEC}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      files.absolutePath(sourceKey),
    ],
    { timeoutMs: 300_000 },
  );
}, 360_000);

afterAll(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

/**
 * Offline provider with a transcript worth captioning.
 *
 * Sentences are ordinary English so the chunker has clause and sentence
 * boundaries to work with, and each is distinct so nothing collapses in
 * ranking. The hook quote is copied out of the transcript, so it passes the
 * same verbatim check a real provider's would.
 */
function fixtureProvider(): AiProvider {
  const LINES = [
    'We shipped the first version on a Friday afternoon and it fell over immediately.',
    'Nobody could work out why, because every dashboard we had was completely green.',
    'So we stopped guessing, and went and read the one log file nobody ever opens.',
    'It turned out a single retry loop was hammering the database every eight seconds.',
    'We deleted four lines of code, and the whole thing has been quiet ever since.',
  ];
  const SEGMENT_SEC = 6;

  const segments = (durationSec: number) => {
    const out: {
      startSec: number;
      endSec: number;
      text: string;
      confidence: number;
      words: { text: string; startSec: number; endSec: number }[];
    }[] = [];

    for (let i = 0, start = 0; start < durationSec; i += 1, start += SEGMENT_SEC) {
      const end = Math.min(start + SEGMENT_SEC, durationSec);
      const text = LINES[i % LINES.length]!;
      const words = text.split(' ');
      out.push({
        startSec: start,
        endSec: end,
        text,
        confidence: 1,
        words: words.map((word, w) => ({
          text: word,
          startSec: start + ((end - start) * w) / words.length,
          endSec: start + ((end - start) * (w + 1)) / words.length,
        })),
      });
    }
    return out;
  };

  const base = createMockProvider();

  return {
    ...base,
    id: 'mock',
    transcription: {
      audioSpec: base.transcription!.audioSpec,
      transcribe: async (request) => ({
        language: 'en',
        model: 'e2e-fixture',
        segments: segments(request.durationSec),
      }),
    },
    clipDiscovery: {
      discoverClips: async (request): Promise<CandidateClipDraft[]> => [
        {
          ...MOMENT,
          hookQuote:
            request.segments.find((s) => s.endSec > MOMENT.startSec && s.startSec < MOMENT.endSec)?.text ??
            null,
          topic: 'The four lines that fixed it',
          reason: 'Fixture: the one moment this test renders.',
          signals: {
            ...EMPTY_CLIP_SIGNALS,
            strongOpening: true,
            story: true,
            payoff: true,
            emotionalIntensity: 0.7,
            informationDensity: 0.8,
            standalone: 0.8,
          },
          confidence: 0.95,
        },
      ],
    },
  };
}

/* -------------------------------------------------------------------------- */

describe('full render pipeline', () => {
  it('takes a real MP4 from upload to a burned-in 9:16 Short', async () => {
    expect(toolchainAvailable, 'FFmpeg is required for this test').toBe(true);

    const files = new LocalFileStore(storageRoot);
    const stores = makeStores();
    const renders = new SqliteClipRenderRepository(stores.db);

    const stats = await files.stat(sourceKey);
    const video: VideoAsset = {
      id: VIDEO_ID,
      originalFilename: 'e2e-source.mp4',
      storageKey: sourceKey,
      sizeBytes: stats!.sizeBytes,
      mimeType: 'video/mp4',
      createdAt: nowIso(),
      // Deliberately unprobed: the pipeline must establish this itself.
      metadata: null,
    };
    await stores.videos.create(video);

    const renderClip = (request: RenderClipPlanRequest) =>
      renderClipPlan(
        {
          ffmpegPath: config.media.ffmpegPath,
          ffprobePath: config.media.ffprobePath,
          media,
          tracking: TRACKING,
          commandTimeoutMs: 600_000,
        },
        request,
      );

    const deps: AnalysisDeps = {
      logger,
      jobs: stores.jobs,
      videos: stores.videos,
      transcripts: stores.transcripts,
      candidates: stores.candidates,
      clipPlans: stores.clipPlans,
      files,
      media,
      provider: fixtureProvider(),
      maxCandidates: 3,
      renders,
      renderClip,
    };

    const job = (await stores.jobs.create(createAnalysisJob(VIDEO_ID))) as AnalysisJob;
    const outcome = await runAnalysis(deps, job);

    /* -- The run itself --------------------------------------------------- */
    expect(outcome.job.failure).toBeNull();
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

    expect(outcome.clipPlans).toHaveLength(1);
    const plan = outcome.clipPlans[0]!;

    /* -- The persisted render record -------------------------------------- */
    expect(outcome.renders).toHaveLength(1);
    const record = outcome.renders[0]!;

    expect(record.status).toBe('RENDERED');
    expect(record.error).toBeNull();
    expect(record.clipPlanId).toBe(plan.id);
    expect(record.storageKey).toBe(renderStorageKey(plan));
    expect(record.width).toBe(1080);
    expect(record.height).toBe(1920);
    expect(record.hasAudio).toBe(true);
    expect(record.cueCount).toBeGreaterThan(0);
    expect(record.durationSec).toBeCloseTo(plan.durationSec, 0);

    const stored = await renders.findByClipPlan(plan.id);
    expect(stored).toMatchObject({ status: 'RENDERED', storageKey: record.storageKey });
    const reloadedJob = await stores.jobs.get(outcome.job.id);
    expect(reloadedJob.type === 'analysis' && reloadedJob.result.renderIds).toEqual([record.id]);

    /* -- The file on disk ------------------------------------------------- */
    const outputPath = files.absolutePath(record.storageKey!);
    expect(await files.exists(record.storageKey!)).toBe(true);

    const probed = await probeStreams(outputPath);
    const videoStream = probed.streams.find((s) => s.codec_type === 'video')!;
    const audioStream = probed.streams.find((s) => s.codec_type === 'audio')!;

    expect(videoStream.width).toBe(1080);
    expect(videoStream.height).toBe(1920);
    expect(videoStream.width! / videoStream.height!).toBe(SHORTS_ASPECT_RATIO);
    expect(videoStream.codec_name).toBe('h264');
    expect(audioStream.codec_name).toBe('aac');
    expect(Number(probed.format.duration)).toBeCloseTo(plan.durationSec, 0);

    // Decodes cleanly: every packet, video and audio, with nothing on stderr.
    const decoded = await runCommand(
      config.media.ffmpegPath,
      ['-nostdin', '-v', 'error', '-i', outputPath, '-f', 'null', '-'],
      { timeoutMs: 600_000 },
    );
    expect(decoded.stderr.trim()).toBe('');

    /* -- The captions are really burned in -------------------------------- */
    const subtitles = buildClipSubtitles(plan, outcome.transcript!, logger)!;
    expect(subtitles.segments.length).toBe(record.cueCount);

    // Every burned word came from the clip's own transcript text.
    for (const cue of subtitles.segments) {
      for (const word of cue.lines.join(' ').split(/\s+/).filter(Boolean)) {
        expect(plan.text).toContain(word);
      }
    }

    // The same plan, same crop, no captions — the only difference between the
    // two files is the burn-in, which is what makes the comparison meaningful.
    const baselinePath = path.join(workDir, 'baseline-no-subtitles.mp4');
    await renderClip({
      source: { ...video, metadata: await media.probe(files.absolutePath(sourceKey)) },
      sourcePath: files.absolutePath(sourceKey),
      plan,
      outputPath: baselinePath,
      subtitles: null,
    });

    // A frame in the middle of the longest cue, so the caption is definitely up.
    const cue = [...subtitles.segments].sort(
      (a, b) => b.endSec - b.startSec - (a.endSec - a.startSec),
    )[0]!;
    const atSec = (cue.startSec + cue.endSec) / 2;

    // The caption block sits inside the bottom of the safe area; the top of the
    // frame is the control region no caption can reach.
    const captionBand = { width: 1080, height: 300, x: 0, y: 1290 };
    const controlBand = { width: 1080, height: 300, x: 0, y: 100 };

    const [renderedCaption, baselineCaption, renderedControl, baselineControl] = await Promise.all([
      grayBand(outputPath, atSec, captionBand, path.join(workDir, 'a-caption.gray')),
      grayBand(baselinePath, atSec, captionBand, path.join(workDir, 'b-caption.gray')),
      grayBand(outputPath, atSec, controlBand, path.join(workDir, 'a-control.gray')),
      grayBand(baselinePath, atSec, controlBand, path.join(workDir, 'b-control.gray')),
    ]);

    const captionDelta = meanAbsoluteDifference(renderedCaption, baselineCaption);
    const controlDelta = meanAbsoluteDifference(renderedControl, baselineControl);

    // Text was drawn where the layout said it would be, and nowhere else.
    expect(captionDelta).toBeGreaterThan(5);
    expect(controlDelta).toBeLessThan(2);
    expect(captionDelta).toBeGreaterThan(controlDelta * 5);

    /* -- Nothing was left behind ------------------------------------------ */
    const rendersDir = await fsp.readdir(path.join(storageRoot, 'renders'));
    expect(rendersDir.filter((entry) => entry.startsWith('.render-'))).toEqual([]);
    expect(rendersDir.filter((entry) => entry.startsWith('.subs-'))).toEqual([]);
    expect(rendersDir).toContain(path.basename(record.storageKey!));

    // The extracted audio is an intermediate and does not outlive the run.
    const workEntries = await fsp.readdir(path.join(storageRoot, 'work')).catch(() => []);
    expect(workEntries).toEqual([]);
  }, 900_000);
});

/* -------------------------------------------------------------------------- */

interface ProbedStreams {
  streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
  format: { duration: string };
}

async function probeStreams(filePath: string): Promise<ProbedStreams> {
  const { stdout } = await runCommand(config.media.ffprobePath, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration',
    '-print_format', 'json',
    filePath,
  ]);

  return JSON.parse(stdout) as ProbedStreams;
}

/**
 * One rectangle of one frame, as 8-bit grey.
 *
 * Written to a file rather than piped: `runCommand` captures stdout as text,
 * which would mangle raw pixels.
 */
async function grayBand(
  filePath: string,
  atSec: number,
  band: { width: number; height: number; x: number; y: number },
  outPath: string,
): Promise<Buffer> {
  await runCommand(
    config.media.ffmpegPath,
    [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(atSec),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', `crop=${band.width}:${band.height}:${band.x}:${band.y},format=gray`,
      '-f', 'rawvideo',
      outPath,
    ],
    { timeoutMs: 120_000 },
  );

  return fsp.readFile(outPath);
}

/** Mean absolute difference in grey levels, 0..255. */
function meanAbsoluteDifference(a: Buffer, b: Buffer): number {
  const length = Math.min(a.length, b.length);
  expect(length).toBeGreaterThan(0);

  let total = 0;
  for (let i = 0; i < length; i += 1) total += Math.abs(a[i]! - b[i]!);
  return total / length;
}
