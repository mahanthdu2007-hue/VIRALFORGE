/**
 * Bounded batching of a PCM byte stream into fixed-size chunks.
 *
 * NVIDIA's NVCF-hosted Parakeet function only serves the unary `Recognize`
 * RPC (see `riva/transport.ts`), which sends the whole recording as one
 * `bytes` field. A 41-minute source at 16 kHz mono is ~80 MB of PCM — well
 * past what any single gRPC message should carry — so `transcription.ts`
 * splits the stream into several bounded `Recognize` calls instead of one.
 *
 * This module only knows about bytes; it has no idea what a "chunk" means to
 * Riva. `batchPcmChunks` re-groups the small (32 KB) pieces `streamPcmChunks`
 * already produces into much larger ones, up to `maxChunkBytes`, without ever
 * needing to know the total length of the recording up front — the
 * generator that owns the disk read is still `streamPcmChunks`, this just
 * buffers its output. Peak memory is one accumulating chunk plus whatever the
 * 32 KB read window costs, regardless of how long the source is.
 */

export interface PcmChunk {
  /** The concatenated samples for this chunk. */
  readonly audio: Uint8Array;
  /** Byte offset of this chunk's first sample, from the start of the PCM data. */
  readonly startByteOffset: number;
  readonly byteLength: number;
}

/**
 * Re-group a PCM byte stream into chunks of at most `maxChunkBytes`.
 *
 * `frameBytes` (channels × bytes-per-sample) anchors every cut to a whole
 * sample frame: `maxChunkBytes` is rounded down to a multiple of it first, so
 * a chunk boundary can never land inside a sample. Since every non-final chunk
 * is exactly that rounded size, boundaries are deterministic byte offsets —
 * chunking the same file twice always produces the same split — and no byte
 * is ever duplicated or dropped between chunks: each one picks up exactly
 * where the last left off.
 *
 * @throws if `maxChunkBytes` is smaller than one frame — a config bug, not a
 *   runtime condition to degrade from.
 */
export async function* batchPcmChunks(
  source: AsyncIterable<Uint8Array>,
  maxChunkBytes: number,
  frameBytes: number,
): AsyncGenerator<PcmChunk> {
  const alignedMax = Math.floor(maxChunkBytes / frameBytes) * frameBytes;
  if (alignedMax <= 0) {
    throw new Error(`maxChunkBytes (${maxChunkBytes}) is smaller than one sample frame (${frameBytes} bytes).`);
  }

  let buffer: Uint8Array[] = [];
  let bufferedBytes = 0;
  let consumedBytes = 0;

  const flush = (): PcmChunk => {
    const audio = new Uint8Array(bufferedBytes);
    let offset = 0;
    for (const piece of buffer) {
      audio.set(piece, offset);
      offset += piece.byteLength;
    }
    const chunk: PcmChunk = { audio, startByteOffset: consumedBytes, byteLength: bufferedBytes };
    consumedBytes += bufferedBytes;
    buffer = [];
    bufferedBytes = 0;
    return chunk;
  };

  for await (const piece of source) {
    let pieceOffset = 0;
    while (pieceOffset < piece.byteLength) {
      const room = alignedMax - bufferedBytes;
      const take = Math.min(room, piece.byteLength - pieceOffset);
      buffer.push(piece.subarray(pieceOffset, pieceOffset + take));
      bufferedBytes += take;
      pieceOffset += take;

      if (bufferedBytes >= alignedMax) yield flush();
    }
  }

  if (bufferedBytes > 0) yield flush();
}
