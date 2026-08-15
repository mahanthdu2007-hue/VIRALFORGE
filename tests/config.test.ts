import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describeConfig, parseEnv } from '@/config/env';
import { isAppError } from '@/lib/errors';

const ROOT = '/srv/app';

describe('parseEnv', () => {
  it('applies defaults when nothing is set', () => {
    const config = parseEnv({}, ROOT);

    expect(config.env).toBe('development');
    expect(config.ai.provider).toBe('mock');
    expect(config.media.ffmpegPath).toBe('ffmpeg');
    expect(config.media.ffprobePath).toBe('ffprobe');
    expect(config.storage.maxUploadBytes).toBe(2048 * 1024 * 1024);
    expect(config.logLevel).toBe('info');
  });

  it('treats blank placeholders in .env.example as unset', () => {
    const config = parseEnv({ GEMINI_API_KEY: '', OPENAI_API_KEY: '   ', FFMPEG_PATH: '' }, ROOT);

    expect(config.ai.keys).toEqual({});
    expect(config.media.ffmpegPath).toBe('ffmpeg');
  });

  it('collects configured provider keys', () => {
    const config = parseEnv({ GEMINI_API_KEY: 'g-key', NVIDIA_API_KEY: 'n-key' }, ROOT);

    expect(config.ai.keys.gemini).toBe('g-key');
    expect(config.ai.keys.nvidia).toBe('n-key');
    expect(config.ai.keys.openai).toBeUndefined();
  });

  it('defaults the NVIDIA model names to the ones documented in .env.example', () => {
    const config = parseEnv({}, ROOT);

    expect(config.ai.models.nvidiaTranscription).toBe('nvidia/parakeet-tdt-0.6b-v2');
    expect(config.ai.models.nvidiaDiscovery).toBe('nvidia/nemotron-3.5-lightning-30b-a3b');
    // Refinement deliberately shares the discovery model; there is no third setting.
    expect(config.ai.nvidiaAsr.endpoint).toBe('grpc.nvcf.nvidia.com:443');
    expect(config.ai.nvidiaAsr.functionId).toBeUndefined();
  });

  it('lets an operator retarget the NVIDIA models and ASR gateway', () => {
    const config = parseEnv(
      {
        NVIDIA_TRANSCRIPTION_MODEL: 'nvidia/parakeet-tdt-0.6b-v3',
        NVIDIA_DISCOVERY_MODEL: 'nvidia/other-model',
        NVIDIA_ASR_ENDPOINT: 'localhost:50051',
        NVIDIA_ASR_FUNCTION_ID: 'fn-123',
      },
      ROOT,
    );

    expect(config.ai.models.nvidiaTranscription).toBe('nvidia/parakeet-tdt-0.6b-v3');
    expect(config.ai.models.nvidiaDiscovery).toBe('nvidia/other-model');
    expect(config.ai.nvidiaAsr).toEqual({ endpoint: 'localhost:50051', functionId: 'fn-123' });
  });

  it('resolves a relative storage dir against the project root', () => {
    const config = parseEnv({ STORAGE_DIR: 'storage' }, ROOT);
    expect(config.storage.rootDir).toMatch(/storage$/);
    expect(config.storage.rootDir).not.toBe('storage');
  });

  it('coerces MAX_UPLOAD_MB to bytes', () => {
    expect(parseEnv({ MAX_UPLOAD_MB: '100' }, ROOT).storage.maxUploadBytes).toBe(100 * 1024 * 1024);
  });

  it('rejects an unknown provider with a validation error', () => {
    try {
      parseEnv({ AI_PROVIDER: 'skynet' }, ROOT);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return;
      expect(error.kind).toBe('validation');
      expect(error.code).toBe('invalid_environment');
      expect(error.details).toMatchObject({ issues: [{ variable: 'AI_PROVIDER' }] });
    }
  });

  it.each([
    ['MAX_UPLOAD_MB', 'not-a-number'],
    ['MAX_UPLOAD_MB', '-5'],
    ['LOG_LEVEL', 'verbose'],
    ['NODE_ENV', 'staging'],
  ])('rejects a malformed %s', (key, value) => {
    expect(() => parseEnv({ [key]: value }, ROOT)).toThrow();
  });
});

describe('describeConfig', () => {
  it('never exposes secret values', () => {
    const config = parseEnv({ GEMINI_API_KEY: 'super-secret', OPENAI_API_KEY: 'also-secret' }, ROOT);
    const described = describeConfig(config);

    expect(JSON.stringify(described)).not.toContain('super-secret');
    expect(JSON.stringify(described)).not.toContain('also-secret');
    expect(described.providersConfigured).toEqual({ gemini: true, openai: true, nvidia: false });
  });

  it('never exposes an absolute filesystem path, even with custom paths configured', () => {
    const config = parseEnv(
      { STORAGE_DIR: 'storage', FFMPEG_PATH: '/opt/custom/ffmpeg', FFPROBE_PATH: '/opt/custom/ffprobe' },
      ROOT,
    );
    const described = describeConfig(config);

    // Sanity: the underlying config still carries the real, usable paths —
    // only the client-facing summary is required to omit them.
    expect(config.storage.rootDir).toContain('storage');
    expect(config.media.ffmpegPath).toBe('/opt/custom/ffmpeg');

    expect(described).not.toHaveProperty('storageRoot');
    expect(described).not.toHaveProperty('databasePath');
    expect(described).not.toHaveProperty('ffmpegPath');
    expect(described).not.toHaveProperty('ffprobePath');

    const serialized = JSON.stringify(described);
    expect(serialized).not.toContain(config.storage.rootDir);
    expect(serialized).not.toContain(config.storage.databasePath);
    expect(serialized).not.toContain('/opt/custom');
    // No drive letter or POSIX-rooted path anywhere in the payload.
    expect(serialized).not.toMatch(/[A-Za-z]:\\|(?<!\\)\/(?:[\w.-]+\/)+[\w.-]+/);

    expect(described.ffmpegConfigured).toEqual({ ffmpegCustomPath: true, ffprobeCustomPath: true });
  });

  it('reports default (non-custom) ffmpeg paths when unset', () => {
    const config = parseEnv({}, ROOT);
    const described = describeConfig(config);

    expect(described.ffmpegConfigured).toEqual({ ffmpegCustomPath: false, ffprobeCustomPath: false });
  });
});

/**
 * Guards the actual `.env.local` on disk against the specific failure that
 * broke NVIDIA transcription: a duplicate key earlier in the file (holding a
 * stray `nvapi-...` secret pasted into a model-name field) silently wins over
 * the correct value below it, because dotenv-style parsers keep the *first*
 * occurrence of a repeated key. `parseEnv` alone cannot catch this — it only
 * ever sees the already-collapsed `process.env`, not the file's duplicates.
 */
describe('.env.local (repo file)', () => {
  const ENV_LOCAL_PATH = path.resolve(import.meta.dirname, '..', '.env.local');

  /** Key -> every value assigned to it, in file order. Ignores comments/blanks. */
  async function parseRawAssignments(filePath: string): Promise<Map<string, string[]>> {
    const text = await readFile(filePath, 'utf8');
    const byKey = new Map<string, string[]>();

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;

      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      const values = byKey.get(key) ?? [];
      values.push(value);
      byKey.set(key, values);
    }

    return byKey;
  }

  it('assigns each NVIDIA variable exactly once, so no earlier duplicate can shadow it', async () => {
    const assignments = await parseRawAssignments(ENV_LOCAL_PATH);

    for (const key of ['NVIDIA_API_KEY', 'NVIDIA_ASR_FUNCTION_ID', 'NVIDIA_TRANSCRIPTION_MODEL', 'NVIDIA_DISCOVERY_MODEL']) {
      const values = assignments.get(key) ?? [];
      expect(values, `${key} should be assigned exactly once in .env.local`).toHaveLength(1);
    }
  });

  it('never puts the nvapi- secret in a model-name field', async () => {
    const assignments = await parseRawAssignments(ENV_LOCAL_PATH);

    for (const key of ['NVIDIA_TRANSCRIPTION_MODEL', 'NVIDIA_DISCOVERY_MODEL']) {
      for (const value of assignments.get(key) ?? []) {
        expect(value.startsWith('nvapi-'), `${key}=${value} looks like an API key, not a model id`).toBe(false);
      }
    }

    for (const value of assignments.get('NVIDIA_API_KEY') ?? []) {
      expect(value.startsWith('nvapi-')).toBe(true);
    }
  });

  it('resolves to the documented NVIDIA model ids and function id', async () => {
    const assignments = await parseRawAssignments(ENV_LOCAL_PATH);
    const only = (key: string) => assignments.get(key)?.[0];

    expect(only('NVIDIA_TRANSCRIPTION_MODEL')).toBe('nvidia/parakeet-tdt-0.6b-v2');
    expect(only('NVIDIA_DISCOVERY_MODEL')).toBe('nvidia/nemotron-3.5-lightning-30b-a3b');
    expect(only('NVIDIA_ASR_FUNCTION_ID')).toBe('d3fe9151-442b-4204-a70d-5fcc597fd610');
  });
});
