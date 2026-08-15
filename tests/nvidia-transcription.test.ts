/**
 * NVIDIA Parakeet transcription contract.
 *
 * Every test substitutes the Riva transport with a plain async generator, so
 * this suite never opens a gRPC channel, never touches the network and never
 * needs a real key. What it pins is the part that would otherwise only be
 * discovered against a live API: the request shape Riva is sent, the metadata
 * that authenticates it, and the mapping from Riva's wire shape onto the
 * existing `TranscriptionDraft` — including what is *omitted* when NVIDIA does
 * not supply a value.
 *
 * The audio is a real 16 kHz mono PCM WAV written to a temp directory, because
 * the streaming reader parses a genuine RIFF header rather than a stub.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNvidiaProvider, NVIDIA_ASR_ENDPOINT, NVIDIA_ASR_FUNCTION_IDS } from '@/ai/providers/nvidia';
import { createNvidiaTranscription, NVIDIA_AUDIO_SPEC } from '@/ai/providers/nvidia/transcription';
import { PCM_CHUNK_BYTES, readWavPcmLayout, streamPcmChunks } from '@/ai/providers/nvidia/wav';
import { requireTranscription } from '@/ai/registry';
import type {
  RivaAsrTransport,
  RivaCallOptions,
  RivaStreamingRequest,
  RivaStreamingResponse,
} from '@/ai/providers/nvidia/riva/transport';

const ASR_MODEL = 'nvidia/parakeet-tdt-0.6b-v2';
const SAMPLE_RATE = 16_000;

let workDir: string;
let audioPath: string;

/** A real RIFF/WAVE header followed by `sampleCount` silent 16-bit samples. */
function pcmWav(sampleCount: number, sampleRateHz = SAMPLE_RATE, channels = 1): Buffer {
  const dataBytes = sampleCount * channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // WAVE_FORMAT_PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * channels * 2, 28); // byte rate
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'viralforge-nvidia-asr-'));
  audioPath = path.join(workDir, 'audio.wav');
  // Just over two chunks, so the streaming path is genuinely exercised.
  await writeFile(audioPath, pcmWav(PCM_CHUNK_BYTES + 4_000));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Transport stub                                                             */
/* -------------------------------------------------------------------------- */

interface Recorded {
  readonly options: RivaCallOptions[];
  readonly requests: RivaStreamingRequest[];
}

/**
 * Records everything sent and replays canned responses. The requests are drained
 * before any response is yielded, which is what lets the assertions below see
 * the whole upload.
 */
function stubTransport(responses: readonly RivaStreamingResponse[]): {
  transport: RivaAsrTransport;
  recorded: Recorded;
} {
  const recorded: Recorded = { options: [], requests: [] };

  const transport: RivaAsrTransport = async function* (options, requests) {
    recorded.options.push(options);
    for await (const request of requests) recorded.requests.push(request);
    yield* responses;
  };

  return { transport, recorded };
}

/** A transport that fails instead of producing a stream. */
const failingTransport = (error: unknown): RivaAsrTransport =>
  async function* () {
    throw error;
  };

/**
 * Records one call per `transport()` invocation — i.e. one per chunk, once
 * transcription splits a recording into several `Recognize` calls — and
 * replays the matching response set for each. `responsesPerCall[i]` answers
 * the i-th call; a call beyond the array answers with no results.
 */
function stubSequentialTransport(responsesPerCall: readonly (readonly RivaStreamingResponse[])[]): {
  transport: RivaAsrTransport;
  calls: RivaStreamingRequest[][];
} {
  const calls: RivaStreamingRequest[][] = [];

  const transport: RivaAsrTransport = async function* (_options, requests) {
    const thisCall: RivaStreamingRequest[] = [];
    calls.push(thisCall);
    for await (const request of requests) thisCall.push(request);
    yield* responsesPerCall[calls.length - 1] ?? [];
  };

  return { transport, calls };
}

const capability = (transport: RivaAsrTransport, overrides: Record<string, unknown> = {}) =>
  createNvidiaTranscription({ apiKey: 'test-key', model: ASR_MODEL, transport, ...overrides });

/** One Riva final result: a transcript plus its word timings, in milliseconds. */
const finalResult = (
  transcript: string,
  words: readonly [string, number, number][],
  extra: Record<string, unknown> = {},
): RivaStreamingResponse => ({
  results: [
    {
      is_final: true,
      alternatives: [
        {
          transcript,
          words: words.map(([word, start_time, end_time]) => ({ word, start_time, end_time })),
          ...extra,
        },
      ],
    },
  ],
});

const TWO_SEGMENTS: readonly RivaStreamingResponse[] = [
  finalResult('I thought it would take a year.', [
    ['I', 1_000, 1_120],
    ['thought', 1_120, 1_480],
    ['year.', 2_200, 2_600],
  ]),
  finalResult('It took three weeks.', [
    ['It', 3_000, 3_140],
    ['weeks.', 3_600, 4_250],
  ]),
];

/* -------------------------------------------------------------------------- */
/* Request shape: endpoint, auth, model/function selection, config flags       */
/* -------------------------------------------------------------------------- */

describe('NVIDIA transcription request', () => {
  it('asks the media engine for 16 kHz mono PCM WAV, which is what Riva streams', () => {
    expect(NVIDIA_AUDIO_SPEC).toEqual({ format: 'wav', sampleRateHz: 16_000, channels: 1 });
    // No upload ceiling: audio is streamed as PCM frames, never posted as a file.
    expect(NVIDIA_AUDIO_SPEC.maxBytes).toBeUndefined();
  });

  it('calls the documented NVIDIA Riva gateway', async () => {
    const { transport, recorded } = stubTransport(TWO_SEGMENTS);
    await capability(transport).transcribe({ audioPath, durationSec: 5 });

    expect(NVIDIA_ASR_ENDPOINT).toBe('grpc.nvcf.nvidia.com:443');
    expect(recorded.options[0]!.endpoint).toBe('grpc.nvcf.nvidia.com:443');
  });

  it('authenticates with a bearer token built from NVIDIA_API_KEY', async () => {
    const { transport, recorded } = stubTransport(TWO_SEGMENTS);
    await capability(transport).transcribe({ audioPath, durationSec: 5 });

    expect(recorded.options[0]!.metadata.authorization).toBe('Bearer test-key');
  });

  it('selects the model with the NVCF function id published for it', async () => {
    const { transport, recorded } = stubTransport(TWO_SEGMENTS);
    await capability(transport).transcribe({ audioPath, durationSec: 5 });

    expect(NVIDIA_ASR_FUNCTION_IDS[ASR_MODEL]).toBe('d3fe9151-442b-4204-a70d-5fcc597fd610');
    expect(recorded.options[0]!.metadata['function-id']).toBe(NVIDIA_ASR_FUNCTION_IDS[ASR_MODEL]);
  });

  it('prefers an explicitly configured function id over the built-in lookup', async () => {
    const { transport, recorded } = stubTransport(TWO_SEGMENTS);
    await capability(transport, { functionId: 'custom-function' }).transcribe({ audioPath, durationSec: 5 });

    expect(recorded.options[0]!.metadata['function-id']).toBe('custom-function');
  });

  it('sends a configuration message first, describing the audio it is about to stream', async () => {
    const { transport, recorded } = stubTransport(TWO_SEGMENTS);
    await capability(transport).transcribe({ audioPath, durationSec: 5 });

    const config = recorded.requests[0]!.streaming_config;
    expect(config).toBeDefined();
    expect(config!.config).toMatchObject({
      encoding: 'LINEAR_PCM',
      sample_rate_hertz: SAMPLE_RATE,
      audio_channel_count: 1,
      language_code: 'en-US',
      max_alternatives: 1,
    });
    // The function id already selects Parakeet; a Riva model name here would be
    // a different identifier and would be rejected.
    expect(config!.config.model).toBe('');
  });

  it('requests word timestamps and punctuation, and forbids paraphrasing', async () => {
    const { transport, recorded } = stubTransport(TWO_SEGMENTS);
    await capability(transport).transcribe({ audioPath, durationSec: 5 });

    const { config, interim_results } = recorded.requests[0]!.streaming_config!;
    expect(config.enable_word_time_offsets).toBe(true);
    expect(config.enable_automatic_punctuation).toBe(true);
    expect(config.verbatim_transcripts).toBe(true);
    // Interim results are revised later in the stream; only finals are durable.
    expect(interim_results).toBe(false);
  });

  it('passes a language hint through instead of assuming English', async () => {
    const { transport, recorded } = stubTransport(TWO_SEGMENTS);
    await capability(transport).transcribe({ audioPath, durationSec: 5, languageHint: 'es-US' });

    expect(recorded.requests[0]!.streaming_config!.config.language_code).toBe('es-US');
  });

  it('sends the whole recording as one Recognize call when it fits under the chunk cap', async () => {
    const { transport, recorded } = stubTransport(TWO_SEGMENTS);
    await capability(transport).transcribe({ audioPath, durationSec: 5 });

    // One `transport()` call for the whole (small) fixture, config + one audio buffer.
    expect(recorded.options).toHaveLength(1);
    const audio = recorded.requests.slice(1);
    expect(audio).toHaveLength(1);
    expect(audio[0]!.audio_content).toBeDefined();

    // Every sample byte arrives exactly once, and the 44-byte header does not.
    expect(audio[0]!.audio_content!.byteLength).toBe((PCM_CHUNK_BYTES + 4_000) * 2);
  });
});

/* -------------------------------------------------------------------------- */
/* Response mapping                                                           */
/* -------------------------------------------------------------------------- */

describe('NVIDIA transcription mapping', () => {
  it('maps final results onto segments timed by their own words', async () => {
    const { transport } = stubTransport(TWO_SEGMENTS);
    const draft = await capability(transport).transcribe({ audioPath, durationSec: 5 });

    expect(draft.model).toBe(ASR_MODEL);
    expect(draft.segments).toHaveLength(2);
    expect(draft.segments[0]).toMatchObject({
      text: 'I thought it would take a year.',
      startSec: 1,
      endSec: 2.6,
    });
    expect(draft.segments[1]).toMatchObject({ text: 'It took three weeks.', startSec: 3, endSec: 4.25 });
  });

  it('converts word offsets from milliseconds to seconds', async () => {
    const { transport } = stubTransport(TWO_SEGMENTS);
    const draft = await capability(transport).transcribe({ audioPath, durationSec: 5 });

    expect(draft.segments[0]!.words).toEqual([
      { text: 'I', startSec: 1, endSec: 1.12 },
      { text: 'thought', startSec: 1.12, endSec: 1.48 },
      { text: 'year.', startSec: 2.2, endSec: 2.6 },
    ]);
  });

  it('ignores interim results, which are revised before they are final', async () => {
    const withInterim: RivaStreamingResponse[] = [
      { results: [{ is_final: false, alternatives: [{ transcript: 'I thought it would' }] }] },
      ...TWO_SEGMENTS,
    ];
    const { transport } = stubTransport(withInterim);
    const draft = await capability(transport).transcribe({ audioPath, durationSec: 5 });

    expect(draft.segments).toHaveLength(2);
    expect(draft.segments.map((s) => s.text)).not.toContain('I thought it would');
  });

  it('drops empty finals rather than recording silence as a segment', async () => {
    const { transport } = stubTransport([
      { results: [{ is_final: true, alternatives: [{ transcript: '   ' }] }] },
      ...TWO_SEGMENTS,
    ]);
    const draft = await capability(transport).transcribe({ audioPath, durationSec: 5 });

    expect(draft.segments).toHaveLength(2);
  });

  it('carries confidence through when it is already on the 0..1 scale', async () => {
    const { transport } = stubTransport([
      finalResult('I thought it would take a year.', [['I', 1_000, 1_200]], { confidence: 0.87 }),
    ]);
    const draft = await capability(transport).transcribe({ audioPath, durationSec: 5 });

    expect(draft.segments[0]!.confidence).toBe(0.87);
  });

  it('omits confidence rather than rescaling a value that is not a probability', async () => {
    const { transport } = stubTransport([
      // Riva returns a placeholder 0 or a log-likelihood on some models.
      finalResult('I thought it would take a year.', [['I', 1_000, 1_200]], { confidence: -12.4 }),
      finalResult('It took three weeks.', [['It', 3_000, 3_200]], { confidence: 0 }),
    ]);
    const draft = await capability(transport).transcribe({ audioPath, durationSec: 5 });

    expect(draft.segments[0]!.confidence).toBeUndefined();
    expect(draft.segments[1]!.confidence).toBeUndefined();
  });

  it('reports the language NVIDIA detected, falling back to the one requested', async () => {
    const detected = stubTransport([
      finalResult('I thought it would take a year.', [['I', 1_000, 1_200]], { language_code: ['en-GB'] }),
    ]);
    await expect(capability(detected.transport).transcribe({ audioPath, durationSec: 5 })).resolves.toMatchObject({
      language: 'en-GB',
    });

    const silent = stubTransport(TWO_SEGMENTS);
    await expect(capability(silent.transport).transcribe({ audioPath, durationSec: 5 })).resolves.toMatchObject({
      language: 'en-US',
    });
  });

  it('returns an empty transcript for audio with no speech, without inventing one', async () => {
    const { transport } = stubTransport([]);
    const draft = await capability(transport).transcribe({ audioPath, durationSec: 5 });

    expect(draft.segments).toEqual([]);
    expect(draft.model).toBe(ASR_MODEL);
  });
});

/* -------------------------------------------------------------------------- */
/* Failure modes                                                              */
/* -------------------------------------------------------------------------- */

describe('NVIDIA transcription failures', () => {
  it('rejects transcript text that arrives with no word timestamps', async () => {
    const { transport } = stubTransport([
      { results: [{ is_final: true, alternatives: [{ transcript: 'I thought it would take a year.' }] }] },
    ]);

    await expect(capability(transport).transcribe({ audioPath, durationSec: 5 })).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_response_invalid',
    });
  });

  it('rejects a response whose words carry no usable offsets', async () => {
    const { transport } = stubTransport([
      {
        results: [
          {
            is_final: true,
            alternatives: [{ transcript: 'I thought so.', words: [{ word: 'I', start_time: Number.NaN }] }],
          },
        ],
      },
    ]);

    await expect(capability(transport).transcribe({ audioPath, durationSec: 5 })).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_response_invalid',
    });
  });

  it('surfaces a transport failure as an ai error, not an unexpected one', async () => {
    await expect(
      capability(failingTransport(new Error('stream reset'))).transcribe({ audioPath, durationSec: 5 }),
    ).rejects.toMatchObject({ kind: 'ai', code: 'provider_unreachable' });
  });

  it('preserves a provider error the transport already classified', async () => {
    const { aiError } = await import('@/lib/errors');
    const rejected = aiError('provider_request_failed', 'NVIDIA transcription rejected the credentials: nope');

    await expect(
      capability(failingTransport(rejected)).transcribe({ audioPath, durationSec: 5 }),
    ).rejects.toMatchObject({ kind: 'ai', code: 'provider_request_failed' });
  });

  it('fails before opening a call when the API key is missing', async () => {
    const transport = vi.fn<RivaAsrTransport>();
    const noKey = createNvidiaTranscription({ apiKey: '', model: ASR_MODEL, transport });

    await expect(noKey.transcribe({ audioPath, durationSec: 5 })).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_not_configured',
      details: { variable: 'NVIDIA_API_KEY' },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('fails before opening a call for a model with no known function id', async () => {
    const transport = vi.fn<RivaAsrTransport>();
    const unknown = createNvidiaTranscription({ apiKey: 'test-key', model: 'nvidia/not-a-real-asr', transport });

    await expect(unknown.transcribe({ audioPath, durationSec: 5 })).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_not_configured',
      details: { variable: 'NVIDIA_ASR_FUNCTION_ID' },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects audio that is not PCM WAV before spending a request', async () => {
    const bogus = path.join(workDir, 'not-audio.wav');
    await writeFile(bogus, Buffer.from('this is not a RIFF file at all'));

    const transport = vi.fn<RivaAsrTransport>();
    const asr = createNvidiaTranscription({ apiKey: 'test-key', model: ASR_MODEL, transport });

    await expect(asr.transcribe({ audioPath: bogus, durationSec: 5 })).rejects.toMatchObject({
      kind: 'media',
      code: 'audio_not_pcm_wav',
    });
    expect(transport).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Chunking: bounded audio for the 30-minute unary Recognize limit           */
/* -------------------------------------------------------------------------- */

describe('NVIDIA transcription chunking', () => {
  // 73,536 bytes of PCM (36,768 samples). At `chunkDurationSec: 0.5` (16,000
  // bytes/chunk at 16 kHz mono 16-bit) that is 5 chunks: four full 16,000-byte
  // chunks and one 9,536-byte remainder.
  const CHUNK_DURATION_SEC = 0.5;
  const BYTES_PER_SECOND = SAMPLE_RATE * 2;
  const MAX_CHUNK_BYTES = CHUNK_DURATION_SEC * BYTES_PER_SECOND;
  const TOTAL_BYTES = (PCM_CHUNK_BYTES + 4_000) * 2;

  it('sends short audio as exactly one Recognize call', async () => {
    const { transport, recorded } = stubTransport(TWO_SEGMENTS);
    // Default chunk duration (5 minutes) comfortably exceeds this fixture.
    await capability(transport).transcribe({ audioPath, durationSec: 5 });

    expect(recorded.options).toHaveLength(1);
  });

  it('splits audio longer than the chunk cap into multiple Recognize calls', async () => {
    const { transport, calls } = stubSequentialTransport([[], [], [], [], []]);
    await createNvidiaTranscription({
      apiKey: 'test-key',
      model: ASR_MODEL,
      transport,
      chunkDurationSec: CHUNK_DURATION_SEC,
    }).transcribe({ audioPath, durationSec: 5 });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls).toHaveLength(5);
  });

  it('keeps every chunk at or under the configured cap, aligned to a whole sample frame', async () => {
    const { transport, calls } = stubSequentialTransport([[], [], [], [], []]);
    await createNvidiaTranscription({
      apiKey: 'test-key',
      model: ASR_MODEL,
      transport,
      chunkDurationSec: CHUNK_DURATION_SEC,
    }).transcribe({ audioPath, durationSec: 5 });

    const byteLengths = calls.map((requests) => requests.find((r) => r.audio_content)!.audio_content!.byteLength);
    for (const length of byteLengths) {
      expect(length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      expect(length % 2).toBe(0); // 16-bit samples: never a half-sample cut.
    }
    // Every chunk but the last is a full chunk; only the last may be shorter.
    expect(byteLengths.slice(0, -1).every((l) => l === MAX_CHUNK_BYTES)).toBe(true);
  });

  it('covers every byte of the source exactly once — no gap, no overlap', async () => {
    const { transport, calls } = stubSequentialTransport([[], [], [], [], []]);
    await createNvidiaTranscription({
      apiKey: 'test-key',
      model: ASR_MODEL,
      transport,
      chunkDurationSec: CHUNK_DURATION_SEC,
    }).transcribe({ audioPath, durationSec: 5 });

    const byteLengths = calls.map((requests) => requests.find((r) => r.audio_content)!.audio_content!.byteLength);
    expect(byteLengths.reduce((a, b) => a + b, 0)).toBe(TOTAL_BYTES);
  });

  it('offsets each chunk\'s segment timestamps by its absolute position in the source', async () => {
    const { transport } = stubSequentialTransport([
      [finalResult('Hello world', [['Hello', 0, 400], ['world', 400, 900]])],
      [finalResult('Second chunk here', [['Second', 100, 500], ['chunk', 500, 900], ['here', 900, 1_200]])],
    ]);

    const draft = await createNvidiaTranscription({
      apiKey: 'test-key',
      model: ASR_MODEL,
      transport,
      chunkDurationSec: CHUNK_DURATION_SEC,
    }).transcribe({ audioPath, durationSec: 5 });

    // Chunk 0 covers [0, 0.5)s, so its segment is unshifted.
    expect(draft.segments[0]).toMatchObject({ text: 'Hello world', startSec: 0, endSec: 0.9 });
    // Chunk 1 starts at 0.5s; its own-relative 0.1s/1.2s become absolute 0.6s/1.7s.
    expect(draft.segments[1]).toMatchObject({ text: 'Second chunk here', startSec: 0.6, endSec: 1.7 });
  });

  it('offsets word-level timings by the same chunk position, not just the segment span', async () => {
    const { transport } = stubSequentialTransport([
      [finalResult('Hello world', [['Hello', 0, 400], ['world', 400, 900]])],
      [finalResult('Second chunk here', [['Second', 100, 500], ['chunk', 500, 900], ['here', 900, 1_200]])],
    ]);

    const draft = await createNvidiaTranscription({
      apiKey: 'test-key',
      model: ASR_MODEL,
      transport,
      chunkDurationSec: CHUNK_DURATION_SEC,
    }).transcribe({ audioPath, durationSec: 5 });

    expect(draft.segments[0]!.words).toEqual([
      { text: 'Hello', startSec: 0, endSec: 0.4 },
      { text: 'world', startSec: 0.4, endSec: 0.9 },
    ]);
    expect(draft.segments[1]!.words).toEqual([
      { text: 'Second', startSec: 0.6, endSec: 1 },
      { text: 'chunk', startSec: 1, endSec: 1.4 },
      { text: 'here', startSec: 1.4, endSec: 1.7 },
    ]);
  });

  it('stitches chunks deterministically: same input, same order, same output every run', async () => {
    const responses: readonly (readonly RivaStreamingResponse[])[] = [
      [finalResult('Hello world', [['Hello', 0, 400], ['world', 400, 900]])],
      [finalResult('Second chunk here', [['Second', 100, 500], ['chunk', 500, 900], ['here', 900, 1_200]])],
    ];

    const run = () =>
      createNvidiaTranscription({
        apiKey: 'test-key',
        model: ASR_MODEL,
        transport: stubSequentialTransport(responses).transport,
        chunkDurationSec: CHUNK_DURATION_SEC,
      }).transcribe({ audioPath, durationSec: 5 });

    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toEqual(second);
    expect(first.segments.map((s) => s.text)).toEqual(['Hello world', 'Second chunk here']);
  });

  it('reports which chunk failed, preserving the original provider error kind and code', async () => {
    const { aiError } = await import('@/lib/errors');
    let call = 0;
    const transport: RivaAsrTransport = async function* (_options, requests) {
      for await (const chunkRequest of requests) void chunkRequest; // drain
      call++;
      if (call === 2) {
        throw aiError('provider_request_failed', 'NVIDIA transcription request failed: INVALID_ARGUMENT');
      }
      yield* [finalResult('Hello world', [['Hello', 0, 400], ['world', 400, 900]])];
    };

    await expect(
      createNvidiaTranscription({
        apiKey: 'test-key',
        model: ASR_MODEL,
        transport,
        chunkDurationSec: CHUNK_DURATION_SEC,
      }).transcribe({ audioPath, durationSec: 5 }),
    ).rejects.toMatchObject({
      kind: 'ai',
      code: 'provider_request_failed',
      message: expect.stringContaining('chunk 1'),
      details: expect.objectContaining({ chunk: expect.objectContaining({ chunkIndex: 1 }) }),
    });
  });
});

/* -------------------------------------------------------------------------- */
/* WAV reader                                                                 */
/* -------------------------------------------------------------------------- */

describe('PCM WAV reader', () => {
  it('reads the format and locates the samples past the header', async () => {
    const layout = await readWavPcmLayout(audioPath);

    expect(layout).toMatchObject({ sampleRateHz: SAMPLE_RATE, channels: 1, bitsPerSample: 16, dataOffset: 44 });
    expect(layout.dataLength).toBe((PCM_CHUNK_BYTES + 4_000) * 2);
  });

  it('skips chunks it does not need to reach the samples', async () => {
    // FFmpeg can emit a LIST/INFO chunk between `fmt ` and `data`.
    const base = pcmWav(100);
    const list = Buffer.alloc(8 + 10);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(10, 4);
    const withList = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
    withList.writeUInt32LE(withList.length - 8, 4);

    const file = path.join(workDir, 'with-list.wav');
    await writeFile(file, withList);

    const layout = await readWavPcmLayout(file);
    expect(layout).toMatchObject({ sampleRateHz: SAMPLE_RATE, dataOffset: 44 + 18, dataLength: 200 });
  });

  it('refuses compressed audio rather than streaming it as raw samples', async () => {
    const encoded = pcmWav(100);
    encoded.writeUInt16LE(3, 20); // WAVE_FORMAT_IEEE_FLOAT
    const file = path.join(workDir, 'float.wav');
    await writeFile(file, encoded);

    await expect(readWavPcmLayout(file)).rejects.toMatchObject({ kind: 'media', code: 'audio_not_pcm_wav' });
  });

  it('yields the payload and nothing else', async () => {
    const layout = await readWavPcmLayout(audioPath);
    let total = 0;
    for await (const chunk of streamPcmChunks(audioPath, layout, 4_096)) {
      expect(chunk.byteLength).toBeLessThanOrEqual(4_096);
      total += chunk.byteLength;
    }
    expect(total).toBe(layout.dataLength);
  });
});

/* -------------------------------------------------------------------------- */
/* Registry: the whole point of the task                                      */
/* -------------------------------------------------------------------------- */

describe('NVIDIA as the complete provider', () => {
  it('resolves transcription without falling back to another provider', async () => {
    const { transport } = stubTransport(TWO_SEGMENTS);
    const provider = createNvidiaProvider({
      apiKey: 'test-key',
      transcriptionModel: ASR_MODEL,
      discoveryModel: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      rivaTransport: transport,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });

    const draft = await requireTranscription(provider).transcribe({ audioPath, durationSec: 5 });
    expect(draft.segments).toHaveLength(2);
    expect(draft.model).toBe(ASR_MODEL);
  });
});
