/**
 * `batchPcmChunks` contract — the primitive `transcription.ts` uses to keep a
 * long recording under the unary `Recognize` message limit without ever
 * holding the whole file in memory.
 *
 * Pure byte-shuffling, no gRPC, no disk: the source is a plain async
 * generator of `Uint8Array` pieces, standing in for `streamPcmChunks`.
 */
import { describe, expect, it } from 'vitest';
import { batchPcmChunks } from '@/ai/providers/nvidia/chunking';

/** A source that yields `pieceSize`-byte pieces until `total` bytes are produced. */
async function* piecesOf(total: number, pieceSize: number): AsyncGenerator<Uint8Array> {
  let emitted = 0;
  let value = 0;
  while (emitted < total) {
    const size = Math.min(pieceSize, total - emitted);
    const piece = new Uint8Array(size);
    for (let i = 0; i < size; i++) piece[i] = value++ % 256;
    yield piece;
    emitted += size;
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('batchPcmChunks', () => {
  it('yields one chunk when the source is smaller than the cap', async () => {
    const chunks = await collect(batchPcmChunks(piecesOf(1_000, 300), 10_000, 2));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.byteLength).toBe(1_000);
    expect(chunks[0]!.startByteOffset).toBe(0);
  });

  it('splits a source larger than the cap into multiple chunks', async () => {
    const chunks = await collect(batchPcmChunks(piecesOf(10_000, 300), 4_000, 2));

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('never yields a chunk larger than the (frame-aligned) cap', async () => {
    const chunks = await collect(batchPcmChunks(piecesOf(10_007, 300), 4_000, 2));

    for (const chunk of chunks) {
      expect(chunk.byteLength).toBeLessThanOrEqual(4_000);
      expect(chunk.audio.byteLength).toBe(chunk.byteLength);
    }
  });

  it('rounds the cap down to a whole sample frame, so a cut never splits a frame', async () => {
    // frameBytes = 4 (e.g. 16-bit stereo); a 4001-byte cap must round to 4000.
    const chunks = await collect(batchPcmChunks(piecesOf(9_000, 700), 4_001, 4));

    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.byteLength).toBe(4_000);
    }
    for (const chunk of chunks) {
      expect(chunk.byteLength % 4).toBe(0);
    }
  });

  it('covers every source byte exactly once, in order, regardless of the source piece size', async () => {
    const total = 10_007;
    const chunks = await collect(batchPcmChunks(piecesOf(total, 333), 4_000, 2));

    const rebuilt = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      expect(chunk.startByteOffset).toBe(offset); // contiguous: no gap, no overlap
      rebuilt.set(chunk.audio, offset);
      offset += chunk.byteLength;
    }
    expect(offset).toBe(total);

    const expected = await collect(piecesOf(total, 333));
    const expectedBytes = new Uint8Array(total);
    let eo = 0;
    for (const piece of expected) {
      expectedBytes.set(piece, eo);
      eo += piece.byteLength;
    }
    expect(rebuilt).toEqual(expectedBytes);
  });

  it('produces the same split for the same input every time (deterministic)', async () => {
    const a = await collect(batchPcmChunks(piecesOf(10_007, 333), 4_000, 2));
    const b = await collect(batchPcmChunks(piecesOf(10_007, 333), 4_000, 2));

    expect(a.map((c) => c.byteLength)).toEqual(b.map((c) => c.byteLength));
    expect(a.map((c) => c.startByteOffset)).toEqual(b.map((c) => c.startByteOffset));
  });

  it('produces no chunk at all for an empty source', async () => {
    const chunks = await collect(batchPcmChunks(piecesOf(0, 300), 4_000, 2));
    expect(chunks).toEqual([]);
  });

  it('rejects a cap smaller than one sample frame rather than looping forever', async () => {
    await expect(collect(batchPcmChunks(piecesOf(100, 10), 1, 2))).rejects.toThrow(/smaller than one sample frame/);
  });
});
