/**
 * `GET /api/system` — environment readiness, sanitised for a client-facing
 * response.
 *
 * `@/runtime` is mocked to a hand-built `Runtime` so this proves the route's
 * shape and its refusal to leak filesystem paths, without spinning up real
 * FFmpeg or an AI provider.
 */

import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/lib/logger';
import { parseEnv } from '@/config/env';

const logger = createLogger({ level: 'error', sink: () => {} });

const ABS_ROOT = process.platform === 'win32' ? 'C:\\srv\\viralforge' : '/srv/viralforge';
const config = parseEnv({ STORAGE_DIR: 'storage', FFMPEG_PATH: '/opt/custom/ffmpeg' }, ABS_ROOT);

const toolchain = {
  available: true,
  ffmpeg: { path: config.media.ffmpegPath, available: true, version: '6.1.1', error: null },
  ffprobe: { path: config.media.ffprobePath, available: true, version: '6.1.1', error: null },
  checkedAt: new Date().toISOString(),
};

vi.mock('@/runtime', () => ({
  getRuntime: () => ({
    logger,
    config,
    media: { toolchain: async () => toolchain },
    aiProvider: () => ({
      id: 'mock',
      displayName: 'Mock (local development)',
      capabilities: ['transcription'],
      health: async () => ({ ok: true, detail: 'Mock provider is always available.', checkedAt: new Date().toISOString() }),
    }),
  }),
}));

describe('GET /api/system', () => {
  it('never includes an absolute filesystem path', async () => {
    const { GET } = await import('../src/app/api/system/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).not.toHaveProperty('config.storageRoot');
    expect(body).not.toHaveProperty('config.databasePath');
    expect(body).not.toHaveProperty('config.ffmpegPath');
    expect(body).not.toHaveProperty('config.ffprobePath');

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(ABS_ROOT);
    expect(serialized).not.toContain('/opt/custom');
    expect(serialized).not.toContain(config.storage.rootDir);
    expect(serialized).not.toContain(config.storage.databasePath);
  });

  it('still reports the diagnostics a client needs', async () => {
    const { GET } = await import('../src/app/api/system/route');
    const response = await GET();
    const body = await response.json();

    expect(body.ffmpeg).toEqual({
      available: true,
      ffmpegVersion: '6.1.1',
      ffprobeVersion: '6.1.1',
      ffmpegError: null,
      ffprobeError: null,
    });
    expect(body.ai.active).toMatchObject({ id: 'mock', ok: true });
    expect(body.config).toMatchObject({
      env: config.env,
      aiProvider: config.ai.provider,
      maxUploadMb: expect.any(Number),
      ffmpegConfigured: { ffmpegCustomPath: true, ffprobeCustomPath: false },
    });
  });
});
