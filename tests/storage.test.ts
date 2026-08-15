import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LocalFileStore, STORAGE_AREAS } from '@/storage/file-store';
import { SqliteVideoRepository } from '@/storage/video-repository';
import { openDatabase } from '@/storage/db';
import { makeMetadata, makeVideoAsset, VIDEO_ID } from './helpers/fixtures';
import type { VideoId } from '@/domain';

let root: string;
let store: LocalFileStore;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'viralforge-test-'));
  store = new LocalFileStore(root);
  await store.init();
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('LocalFileStore', () => {
  it('creates every storage area', async () => {
    for (const area of STORAGE_AREAS) {
      await expect(fsp.stat(path.join(root, area))).resolves.toBeDefined();
    }
  });

  it('streams bytes to disk and reports the size written', async () => {
    const payload = Buffer.from('fake video bytes');
    const stored = await store.writeStream('uploads', 'clip.mp4', Readable.from(payload));

    expect(stored.key).toBe('uploads/clip.mp4');
    expect(stored.sizeBytes).toBe(payload.byteLength);
    await expect(fsp.readFile(store.absolutePath(stored.key))).resolves.toEqual(payload);
  });

  it('accepts a web ReadableStream, as arrives from a request body', async () => {
    const web = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk-a'));
        controller.enqueue(new TextEncoder().encode('chunk-b'));
        controller.close();
      },
    });

    const stored = await store.writeStream('work', 'web.bin', web);
    expect(stored.sizeBytes).toBe(14);
  });

  it('aborts and deletes the partial file when maxBytes is exceeded', async () => {
    const big = Readable.from([Buffer.alloc(64), Buffer.alloc(64)]);

    await expect(store.writeStream('uploads', 'big.mp4', big, { maxBytes: 100 })).rejects.toMatchObject({
      kind: 'validation',
      code: 'upload_too_large',
    });

    expect(await store.exists('uploads/big.mp4')).toBe(false);
  });

  it('sanitises the target name so a key cannot contain a path', async () => {
    const stored = await store.writeStream('uploads', '../../escape.mp4', Readable.from(Buffer.from('x')));
    expect(stored.key).toBe('uploads/escape.mp4');
  });

  it('refuses to resolve a key outside the storage root', () => {
    expect(() => store.absolutePath('../../../etc/passwd')).toThrowError(/outside the storage root/);
  });

  it('reports absence rather than throwing', async () => {
    expect(await store.exists('uploads/nope.mp4')).toBe(false);
    expect(await store.stat('uploads/nope.mp4')).toBeNull();
  });

  it('removes a file idempotently', async () => {
    await store.writeStream('renders', 'out.mp4', Readable.from(Buffer.from('x')));
    await store.remove('renders/out.mp4');
    await store.remove('renders/out.mp4');
    expect(await store.exists('renders/out.mp4')).toBe(false);
  });
});

describe('SqliteVideoRepository', () => {
  const repo = () => new SqliteVideoRepository(openDatabase(':memory:'));

  it('stores and retrieves an asset, metadata included', async () => {
    const videos = repo();
    const asset = makeVideoAsset();

    await videos.create(asset);
    expect(await videos.get(asset.id)).toEqual(asset);
    expect((await videos.get(asset.id)).metadata?.fps).toBe(30);
  });

  it('throws not_found for an unknown id and returns null from find', async () => {
    const videos = repo();
    const missing = 'aaaaaaaa-0000-4000-8000-000000000000' as VideoId;

    expect(await videos.find(missing)).toBeNull();
    await expect(videos.get(missing)).rejects.toMatchObject({ kind: 'not_found', code: 'video_not_found' });
  });

  it('round-trips a null metadata column', async () => {
    const videos = repo();
    await videos.create(makeVideoAsset({ metadata: null }));
    expect((await videos.get(VIDEO_ID)).metadata).toBeNull();
  });

  it('upserts on save, so metadata can be attached after probing', async () => {
    const videos = repo();
    await videos.create(makeVideoAsset({ metadata: null }));
    await videos.save(makeVideoAsset({ metadata: makeMetadata({ durationSec: 1234 }) }));

    expect((await videos.get(VIDEO_ID)).metadata?.durationSec).toBe(1234);
    expect(await videos.list()).toHaveLength(1);
  });

  it('lists newest first', async () => {
    const videos = repo();
    await videos.create(makeVideoAsset({ id: 'v-old' as VideoId, createdAt: '2026-01-01T00:00:00.000Z' as never }));
    await videos.create(makeVideoAsset({ id: 'v-new' as VideoId, createdAt: '2026-06-01T00:00:00.000Z' as never }));

    expect((await videos.list()).map((v) => v.id)).toEqual(['v-new', 'v-old']);
  });
});
