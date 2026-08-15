import { describe, expect, it } from 'vitest';
import { parseEnv } from '@/config/env';
import {
  optionalClipRefinement,
  registeredProviderIds,
  requireClipDiscovery,
  requireFraming,
  requireTranscription,
  resolveProvider,
} from '@/ai/registry';
import { AI_CAPABILITIES, supports, type AiProvider } from '@/ai/types';
import { createMockProvider } from '@/ai/providers/mock';
import { isUnitScore, SHORT_MAX_DURATION_SEC, SHORT_MIN_DURATION_SEC, SHORTS_ASPECT_RATIO } from '@/domain';
import { isAppError } from '@/lib/errors';

const config = parseEnv({ AI_PROVIDER: 'mock' }, process.cwd());

describe('registry', () => {
  it('resolves the configured provider', () => {
    const provider = resolveProvider(config);
    expect(provider.id).toBe('mock');
  });

  it('reports which providers are implemented', () => {
    expect([...registeredProviderIds()].sort()).toEqual(['mock', 'nvidia', 'openai']);
  });

  it('resolves the OpenAI provider when a key is configured', () => {
    const provider = resolveProvider(parseEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }, process.cwd()));

    expect(provider.id).toBe('openai');
    expect(provider.capabilities).toContain('transcription');
    expect(provider.capabilities).toContain('clip-discovery');
  });

  it('refuses to resolve OpenAI without a key instead of falling back to mock', () => {
    expect(() => resolveProvider(parseEnv({ AI_PROVIDER: 'openai' }, process.cwd()))).toThrowError(
      /OPENAI_API_KEY is required/,
    );
  });

  it('resolves the NVIDIA provider when a key is configured', () => {
    const provider = resolveProvider(parseEnv({ AI_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'k' }, process.cwd()));

    expect(provider.id).toBe('nvidia');
    expect(provider.capabilities).toContain('transcription');
    expect(provider.capabilities).toContain('clip-discovery');
    expect(provider.capabilities).toContain('clip-refinement');
  });

  it('resolves every capability from NVIDIA alone, with no OpenAI key present', () => {
    const config = parseEnv({ AI_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'k' }, process.cwd());
    expect(config.ai.keys.openai).toBeUndefined();

    const provider = resolveProvider(config);
    // The guard that used to throw capability_unsupported for AI_PROVIDER=nvidia.
    expect(() => requireTranscription(provider)).not.toThrow();
    expect(() => requireClipDiscovery(provider)).not.toThrow();
    expect(optionalClipRefinement(provider)).not.toBeNull();
  });

  it('refuses to resolve NVIDIA without a key instead of falling back to mock', () => {
    expect(() => resolveProvider(parseEnv({ AI_PROVIDER: 'nvidia' }, process.cwd()))).toThrowError(
      /NVIDIA_API_KEY is required/,
    );
  });

  it('fails loudly for a provider that has no implementation yet', () => {
    try {
      resolveProvider(parseEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' }, process.cwd()));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return;
      expect(error.kind).toBe('ai');
      expect(error.code).toBe('provider_not_available');
    }
  });
});

describe('capability guards', () => {
  it('returns the capability when the provider declares it', () => {
    const provider = createMockProvider();
    expect(requireTranscription(provider)).toBeDefined();
    expect(requireClipDiscovery(provider)).toBeDefined();
    expect(requireFraming(provider)).toBeDefined();
  });

  it('throws an ai error when a capability is absent', () => {
    const bare: AiProvider = {
      id: 'mock',
      displayName: 'Bare',
      capabilities: [],
      health: async () => ({ ok: true, detail: '', checkedAt: new Date().toISOString() }),
    };

    for (const guard of [requireTranscription, requireClipDiscovery, requireFraming]) {
      expect(() => guard(bare)).toThrowError(/does not support/);
    }
  });

  it('keeps declared capabilities and implemented methods in agreement', () => {
    const provider = createMockProvider();
    const implemented = {
      transcription: provider.transcription !== undefined,
      'clip-discovery': provider.clipDiscovery !== undefined,
      'clip-refinement': provider.clipRefinement !== undefined,
      framing: provider.framing !== undefined,
    } as const;

    for (const capability of AI_CAPABILITIES) {
      expect(supports(provider, capability)).toBe(implemented[capability]);
    }
  });
});

describe('mock provider', () => {
  const provider = createMockProvider();

  it('reports healthy without any API key', async () => {
    await expect(provider.health()).resolves.toMatchObject({ ok: true });
  });

  it('produces contiguous transcript segments covering the duration', async () => {
    const draft = await requireTranscription(provider).transcribe({ audioPath: '/tmp/a.wav', durationSec: 12 });

    expect(draft.model).toBe('mock-v1');
    expect(draft.segments.map((s) => [s.startSec, s.endSec])).toEqual([
      [0, 5],
      [5, 10],
      [10, 12],
    ]);
    // Labelled as mock so it can never be mistaken for real speech.
    expect(draft.segments.every((s) => s.text.startsWith('[mock'))).toBe(true);
  });

  it('supplies word timings that stay inside their segment', async () => {
    const draft = await requireTranscription(provider).transcribe({ audioPath: '/tmp/a.wav', durationSec: 12 });

    for (const segment of draft.segments) {
      expect(segment.words?.length).toBeGreaterThan(0);
      for (const word of segment.words ?? []) {
        expect(word.startSec).toBeGreaterThanOrEqual(segment.startSec);
        expect(word.endSec).toBeLessThanOrEqual(segment.endSec);
        expect(word.endSec).toBeGreaterThan(word.startSec);
      }
    }
  });

  it('declares the audio it wants so the pipeline does not guess', () => {
    expect(requireTranscription(provider).audioSpec).toMatchObject({ sampleRateHz: 16_000, channels: 1 });
  });

  it('rejects a non-positive duration', async () => {
    await expect(
      requireTranscription(provider).transcribe({ audioPath: '/tmp/a.wav', durationSec: 0 }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('discovers non-overlapping candidates inside the target window', async () => {
    const candidates = await requireClipDiscovery(provider).discoverClips({
      segments: [{ startSec: 0, endSec: 5, text: 'Opening line.' }],
      videoDurationSec: 600,
      maxCandidates: 3,
      targetDurationSec: { min: SHORT_MIN_DURATION_SEC, max: SHORT_MAX_DURATION_SEC },
    });

    expect(candidates).toHaveLength(3);

    for (const candidate of candidates) {
      const duration = candidate.endSec - candidate.startSec;
      expect(duration).toBeGreaterThanOrEqual(SHORT_MIN_DURATION_SEC);
      expect(duration).toBeLessThanOrEqual(SHORT_MAX_DURATION_SEC);
      expect(isUnitScore(candidate.signals.standalone)).toBe(true);
      expect(candidate.reason).toContain('Mock');
      // Discovery reports signals; scoring is a later phase's job.
      expect(candidate).not.toHaveProperty('score');
    }

    for (let i = 1; i < candidates.length; i += 1) {
      expect(candidates[i]!.startSec).toBeGreaterThanOrEqual(candidates[i - 1]!.endSec);
    }
  });

  it('ranks candidates in descending order of confidence', async () => {
    const candidates = await requireClipDiscovery(provider).discoverClips({
      segments: [],
      videoDurationSec: 600,
      maxCandidates: 4,
      targetDurationSec: { min: SHORT_MIN_DURATION_SEC, max: SHORT_MAX_DURATION_SEC },
    });

    const scores = candidates.map((c) => c.confidence ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('returns at least one candidate for a video shorter than the target', async () => {
    const candidates = await requireClipDiscovery(provider).discoverClips({
      segments: [],
      videoDurationSec: 20,
      maxCandidates: 3,
      targetDurationSec: { min: SHORT_MIN_DURATION_SEC, max: SHORT_MAX_DURATION_SEC },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.startSec).toBe(0);
    expect(candidates[0]!.endSec).toBe(20);
  });

  it('plans a centred 9:16 crop that fits inside the source frame', async () => {
    const draft = await requireFraming(provider).planFraming({
      clipRange: { startSec: 0, endSec: 30 },
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetAspectRatio: SHORTS_ASPECT_RATIO,
      sampleFramePaths: [],
    });

    expect(draft.strategy).toBe('static');
    const [kf] = draft.keyframes;
    expect(kf).toBeDefined();
    expect(kf!.width).toBe(608);
    expect(kf!.height).toBe(1080);
    expect(kf!.x + kf!.width).toBeLessThanOrEqual(1920);
    expect(kf!.y + kf!.height).toBeLessThanOrEqual(1080);
  });
});
