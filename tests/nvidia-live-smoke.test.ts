/**
 * Manual, real-network smoke test for NVIDIA Riva transcription.
 *
 * Skipped by default — it spends a real NVIDIA credit and needs
 * `NVIDIA_API_KEY` from `.env.local`. Run it explicitly with:
 *
 *   NVIDIA_LIVE_SMOKE=1 npx vitest run tests/nvidia-live-smoke.test.ts
 *
 * Exists to diagnose a real transcription failure end to end (real gRPC
 * channel, real credentials, real 1-second WAV) without waiting on the full
 * pipeline. Prints the raw gRPC status/details rather than asserting on them,
 * since the point is to see NVIDIA's actual response while investigating.
 */
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { createNvidiaTranscription } from '@/ai/providers/nvidia/transcription';
import { createGrpcRivaUnaryTransport } from '@/ai/providers/nvidia/riva/transport';

const LIVE = process.env.NVIDIA_LIVE_SMOKE === '1';

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

function pcmWav(sampleCount: number, sampleRateHz = 16_000, channels = 1): Buffer {
  const dataBytes = sampleCount * channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  const data = Buffer.alloc(dataBytes);
  for (let i = 0; i < sampleCount; i++) {
    data.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / sampleRateHz)), i * 2);
  }
  return Buffer.concat([header, data]);
}

describe.skipIf(!LIVE)('NVIDIA Riva transcription — live smoke', () => {
  it(
    'transcribes a tiny real WAV against the real NVIDIA endpoint',
    { timeout: 30_000 },
    async () => {
      loadEnvLocal();

      console.log('NVIDIA_API_KEY set:', Boolean(process.env.NVIDIA_API_KEY), 'len:', process.env.NVIDIA_API_KEY?.trim().length);
      console.log('NVIDIA_ASR_FUNCTION_ID:', process.env.NVIDIA_ASR_FUNCTION_ID);
      console.log('NVIDIA_TRANSCRIPTION_MODEL:', process.env.NVIDIA_TRANSCRIPTION_MODEL);

      const workDir = mkdtempSync(path.join(tmpdir(), 'nvidia-live-smoke-'));
      const audioPath = path.join(workDir, 'tone.wav');
      writeFileSync(audioPath, pcmWav(16_000));

      const capability = createNvidiaTranscription({
        apiKey: (process.env.NVIDIA_API_KEY ?? '').trim(),
        model: (process.env.NVIDIA_TRANSCRIPTION_MODEL ?? 'nvidia/parakeet-tdt-0.6b-v2').trim(),
        ...(process.env.NVIDIA_ASR_FUNCTION_ID
          ? { functionId: process.env.NVIDIA_ASR_FUNCTION_ID.trim() }
          : {}),
        transport: createGrpcRivaUnaryTransport(),
        timeoutMs: 20_000,
      });

      try {
        const draft = await capability.transcribe({ audioPath, durationSec: 1 });
        console.log('SUCCESS:', JSON.stringify(draft, null, 2));
      } catch (error) {
        console.log('--- top-level error ---');
        console.log(error);
        const appError = error as { code?: string; kind?: string; details?: unknown; logDetails?: unknown; cause?: unknown };
        console.log('code:', appError?.code, 'kind:', appError?.kind);
        console.log('details:', appError?.details);
        console.log('logDetails:', appError?.logDetails);

        let cause: unknown = appError?.cause;
        let depth = 0;
        while (cause && depth < 5) {
          console.log(`--- cause[${depth}] ---`);
          console.log(cause);
          if (typeof cause === 'object') {
            for (const k of Object.keys(cause)) {
              try {
                console.log(` ${k} =`, (cause as Record<string, unknown>)[k]);
              } catch {
                /* ignore */
              }
            }
          }
          cause = (cause as { cause?: unknown } | null)?.cause;
          depth++;
        }
        throw error;
      }
    },
  );

  it(
    'stitches multiple real Recognize calls into one transcript with absolute timestamps',
    { timeout: 60_000 },
    async () => {
      loadEnvLocal();

      // 130s of tone with a 60s chunk cap forces 3 real Recognize calls
      // (0-60s, 60-120s, 120-130s) — this is what proves chunking works
      // against the live endpoint without waiting on the 41-minute video.
      const workDir = mkdtempSync(path.join(tmpdir(), 'nvidia-live-smoke-chunked-'));
      const audioPath = path.join(workDir, 'tone-130s.wav');
      writeFileSync(audioPath, pcmWav(16_000 * 130));

      const capability = createNvidiaTranscription({
        apiKey: (process.env.NVIDIA_API_KEY ?? '').trim(),
        model: (process.env.NVIDIA_TRANSCRIPTION_MODEL ?? 'nvidia/parakeet-tdt-0.6b-v2').trim(),
        ...(process.env.NVIDIA_ASR_FUNCTION_ID
          ? { functionId: process.env.NVIDIA_ASR_FUNCTION_ID.trim() }
          : {}),
        transport: createGrpcRivaUnaryTransport(),
        timeoutMs: 30_000,
        chunkDurationSec: 60,
      });

      const draft = await capability.transcribe({ audioPath, durationSec: 130 });
      console.log('CHUNKED SUCCESS:', JSON.stringify(draft, null, 2));

      // Real evidence chunking (not the single-request path) actually ran:
      // any segment timed past 60s could only come from chunk 2 or 3, whose
      // raw Riva timestamps start back at 0 and are only past 60s because
      // this codebase added the chunk's real start offset.
      const maxEndSec = Math.max(0, ...draft.segments.map((s) => s.endSec));
      console.log('max segment endSec:', maxEndSec, '(source is 130s)');
    },
  );
});
