/**
 * Environment configuration.
 *
 * `parseEnv` is pure and takes its source explicitly so it is directly
 * testable; `getConfig` is the memoised process-wide accessor. Reading
 * `process.env` anywhere else in the codebase is a bug.
 */

import { z } from 'zod';
import path from 'node:path';
import { LOG_LEVELS } from '@/lib/logger';
import { validationError } from '@/lib/errors';
import { SUBJECT_TRACKER_MODES, YUNET_MODEL_FILENAME, type SubjectTrackerMode } from '@/tracking';

/** Providers the AI abstraction can resolve. Only `mock` is live in Phase 1. */
export const AI_PROVIDER_IDS = ['mock', 'gemini', 'openai', 'nvidia'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/** Treats "" the same as unset, which is how `.env.example` placeholders read. */
const optionalSecret = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? undefined : v))
  .optional();

const optionalPath = optionalSecret;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  GEMINI_API_KEY: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
  NVIDIA_API_KEY: optionalSecret,
  AI_PROVIDER: z.enum(AI_PROVIDER_IDS).default('mock'),

  // Model names are configuration, not code: a model rename must not need a
  // release. Defaults are the ones documented in `.env.example`.
  OPENAI_TRANSCRIPTION_MODEL: z.string().trim().min(1).default('whisper-1'),
  OPENAI_DISCOVERY_MODEL: z.string().trim().min(1).default('gpt-4o-mini'),
  NVIDIA_DISCOVERY_MODEL: z.string().trim().min(1).default('nvidia/nemotron-3.5-lightning-30b-a3b'),
  NVIDIA_TRANSCRIPTION_MODEL: z.string().trim().min(1).default('nvidia/parakeet-tdt-0.6b-v2'),
  /**
   * `host:port` of the Riva ASR gateway. NVIDIA hosts Parakeet as an NVCF gRPC
   * function; point this at a self-hosted Speech NIM to run it locally.
   */
  NVIDIA_ASR_ENDPOINT: z.string().trim().min(1).default('grpc.nvcf.nvidia.com:443'),
  /**
   * NVCF function id for the ASR model. Optional: the provider knows the id for
   * the models NVIDIA publishes, and only needs this for one it does not.
   */
  NVIDIA_ASR_FUNCTION_ID: optionalSecret,

  FFMPEG_PATH: optionalPath,
  FFPROBE_PATH: optionalPath,

  STORAGE_DIR: z.string().trim().min(1).default('storage'),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().max(65536).default(2048),
  /** SQLite file, relative to the storage root. `:memory:` is honoured for tests. */
  DATABASE_FILE: z.string().trim().min(1).default('viralforge.db'),

  /**
   * Which subject tracker runs. `center` is the deterministic default and needs
   * nothing installed; `face` additionally needs the optional
   * `onnxruntime-node` package and the YuNet weights (see README).
   */
  SUBJECT_TRACKER: z.enum(SUBJECT_TRACKER_MODES).default('center'),
  /** `.onnx` weights for `face`. Defaults to `<storage>/models/<yunet>`. */
  SUBJECT_DETECTOR_MODEL_PATH: optionalPath,
  /** Frames sampled per second of source. The main cost lever. */
  SUBJECT_DETECTOR_FPS: z.coerce.number().positive().max(15).default(2),
  /** Hard ceiling on frames per clip, so a long range cannot run away. */
  SUBJECT_DETECTOR_MAX_FRAMES: z.coerce.number().int().positive().max(2000).default(240),
  /** Longest edge of a decoded frame. Detection gains little above this. */
  SUBJECT_DETECTOR_MAX_EDGE_PX: z.coerce.number().int().min(64).max(1920).default(640),
  /** Detections below this are not evidence of a subject. */
  SUBJECT_DETECTOR_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),

  /** Concurrent analysis jobs. One FFmpeg + one upload at a time is plenty on 16 GB. */
  JOB_CONCURRENCY: z.coerce.number().int().positive().max(8).default(1),
  /** How many moments discovery may return per video. */
  MAX_CANDIDATES: z.coerce.number().int().positive().max(50).default(12),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type RawEnv = z.input<typeof envSchema>;

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly isProduction: boolean;

  readonly ai: {
    readonly provider: AiProviderId;
    /** Present only for providers whose key is configured. */
    readonly keys: Readonly<Partial<Record<Exclude<AiProviderId, 'mock'>, string>>>;
    readonly models: {
      readonly openaiTranscription: string;
      readonly openaiDiscovery: string;
      readonly nvidiaDiscovery: string;
      readonly nvidiaTranscription: string;
    };
    /** Riva ASR transport settings. Only read when the provider is `nvidia`. */
    readonly nvidiaAsr: {
      readonly endpoint: string;
      /** Undefined means "use the id the provider knows for this model". */
      readonly functionId: string | undefined;
    };
  };

  readonly media: {
    /** Absolute path or bare command resolved from PATH. */
    readonly ffmpegPath: string;
    readonly ffprobePath: string;
  };

  readonly storage: {
    /** Absolute. Root for uploads, work files and renders. */
    readonly rootDir: string;
    readonly maxUploadBytes: number;
    /** Absolute path to the SQLite file, or the literal `:memory:`. */
    readonly databasePath: string;
  };

  readonly jobs: {
    readonly concurrency: number;
    readonly maxCandidates: number;
  };

  /**
   * Subject tracking. Present whatever the mode: `createSubjectTracker` decides
   * what is actually runnable, and reports when it had to fall back.
   */
  readonly tracking: {
    readonly mode: SubjectTrackerMode;
    /** Absolute path to the detector weights, whether or not they exist yet. */
    readonly modelPath: string;
    readonly fps: number;
    readonly maxFrames: number;
    readonly maxEdgePx: number;
    readonly minConfidence: number;
  };

  readonly logLevel: (typeof LOG_LEVELS)[number];
}

/**
 * Validate a raw environment bag into an `AppConfig`.
 *
 * @param source raw variables, typically `process.env`
 * @param projectRoot base for resolving a relative `STORAGE_DIR`
 * @throws AppError kind=validation when any variable is malformed
 */
export function parseEnv(source: Record<string, string | undefined>, projectRoot = process.cwd()): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      variable: i.path.join('.') || '(root)',
      problem: i.message,
    }));
    throw validationError('invalid_environment', 'Environment configuration is invalid.', {
      details: { issues },
    });
  }

  const e = result.data;

  const keys: Partial<Record<Exclude<AiProviderId, 'mock'>, string>> = {};
  if (e.GEMINI_API_KEY) keys.gemini = e.GEMINI_API_KEY;
  if (e.OPENAI_API_KEY) keys.openai = e.OPENAI_API_KEY;
  if (e.NVIDIA_API_KEY) keys.nvidia = e.NVIDIA_API_KEY;

  const rootDir = path.resolve(projectRoot, e.STORAGE_DIR);

  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    ai: {
      provider: e.AI_PROVIDER,
      keys,
      models: {
        openaiTranscription: e.OPENAI_TRANSCRIPTION_MODEL,
        openaiDiscovery: e.OPENAI_DISCOVERY_MODEL,
        nvidiaDiscovery: e.NVIDIA_DISCOVERY_MODEL,
        nvidiaTranscription: e.NVIDIA_TRANSCRIPTION_MODEL,
      },
      nvidiaAsr: { endpoint: e.NVIDIA_ASR_ENDPOINT, functionId: e.NVIDIA_ASR_FUNCTION_ID },
    },
    media: {
      ffmpegPath: e.FFMPEG_PATH ?? 'ffmpeg',
      ffprobePath: e.FFPROBE_PATH ?? 'ffprobe',
    },
    storage: {
      rootDir,
      maxUploadBytes: e.MAX_UPLOAD_MB * 1024 * 1024,
      // `:memory:` must reach SQLite untouched, not become a file path.
      databasePath: e.DATABASE_FILE === ':memory:' ? ':memory:' : path.resolve(rootDir, e.DATABASE_FILE),
    },
    jobs: { concurrency: e.JOB_CONCURRENCY, maxCandidates: e.MAX_CANDIDATES },
    tracking: {
      mode: e.SUBJECT_TRACKER,
      // Under the storage root by default: it is already excluded from version
      // control, which is where a few hundred KB of weights belong.
      modelPath: e.SUBJECT_DETECTOR_MODEL_PATH
        ? path.resolve(projectRoot, e.SUBJECT_DETECTOR_MODEL_PATH)
        : path.resolve(rootDir, 'models', YUNET_MODEL_FILENAME),
      fps: e.SUBJECT_DETECTOR_FPS,
      maxFrames: e.SUBJECT_DETECTOR_MAX_FRAMES,
      maxEdgePx: e.SUBJECT_DETECTOR_MAX_EDGE_PX,
      minConfidence: e.SUBJECT_DETECTOR_MIN_CONFIDENCE,
    },
    logLevel: e.LOG_LEVEL,
  };
}

let cached: AppConfig | undefined;

/** Process-wide config, parsed once. Throws on first call if the env is bad. */
export function getConfig(): AppConfig {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test hook only — drops the memoised config. */
export function resetConfigCache(): void {
  cached = undefined;
}

/**
 * Redacted view of the config, safe to log or expose over the API.
 * Secrets collapse to a boolean: configured or not.
 */
/**
 * Client-facing environment summary.
 *
 * This is served over `GET /api/system` to an untrusted caller, so it never
 * includes a filesystem path — not `storageRoot`, not `databasePath`, not
 * `ffmpegPath`/`ffprobePath` when an operator points those at a custom
 * absolute location. FFmpeg reachability is still reported, just as a
 * boolean rather than the path that proves it; the `/api/system` route adds
 * the actual version and health on top of this.
 */
export function describeConfig(config: AppConfig) {
  return {
    env: config.env,
    aiProvider: config.ai.provider,
    providersConfigured: {
      gemini: Boolean(config.ai.keys.gemini),
      openai: Boolean(config.ai.keys.openai),
      nvidia: Boolean(config.ai.keys.nvidia),
    },
    ffmpegConfigured: {
      // Whether an operator pointed FFMPEG_PATH/FFPROBE_PATH at a custom
      // location vs. resolving the bare command from PATH — useful for
      // support without disclosing where on disk it lives.
      ffmpegCustomPath: config.media.ffmpegPath !== 'ffmpeg',
      ffprobeCustomPath: config.media.ffprobePath !== 'ffprobe',
    },
    maxUploadMb: Math.round(config.storage.maxUploadBytes / (1024 * 1024)),
    jobConcurrency: config.jobs.concurrency,
    maxCandidates: config.jobs.maxCandidates,
    subjectTracker: config.tracking.mode,
    // The path itself is a local absolute path and not something to expose;
    // whether the weights are configured is the useful part.
    subjectDetectorFps: config.tracking.fps,
    logLevel: config.logLevel,
  };
}
