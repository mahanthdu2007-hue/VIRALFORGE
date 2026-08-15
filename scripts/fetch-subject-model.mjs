#!/usr/bin/env node
/**
 * Fetch the subject-detection weights.
 *
 * The model is not in the repository and never should be: it is a binary
 * artefact with its own licence and its own upstream, and vendoring it would put
 * a quarter of a megabyte of weights into every clone for a feature that is
 * optional. It lands under the storage root instead, which is already excluded
 * from version control.
 *
 *   node scripts/fetch-subject-model.mjs [--force] [--out <path>]
 *
 * Model: YuNet face detector (`face_detection_yunet_2023mar.onnx`) from OpenCV's
 * model zoo, MIT licensed, 232 KB. It is stored there with Git LFS, so the
 * download uses the LFS media host — the plain `raw.githubusercontent.com` URL
 * returns a 131-byte pointer file that looks like a successful download and then
 * fails to load.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const MODEL_FILENAME = 'face_detection_yunet_2023mar.onnx';
const MODEL_URL =
  'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/' +
  MODEL_FILENAME;

/** Anything much smaller is an LFS pointer or an error page, not a model. */
const MIN_PLAUSIBLE_BYTES = 100_000;

const args = process.argv.slice(2);
const force = args.includes('--force');
const outFlag = args.indexOf('--out');
const storageDir = process.env.STORAGE_DIR ?? 'storage';

const target = path.resolve(
  outFlag >= 0 && args[outFlag + 1]
    ? args[outFlag + 1]
    : process.env.SUBJECT_DETECTOR_MODEL_PATH ?? path.join(storageDir, 'models', MODEL_FILENAME),
);

const existing = await fsp.stat(target).catch(() => null);
if (existing?.isFile() && !force) {
  console.log(`Already present: ${target} (${existing.size} bytes). Use --force to re-download.`);
  process.exit(0);
}

console.log(`Downloading ${MODEL_URL}`);
console.log(`         to ${target}`);

const response = await fetch(MODEL_URL);
if (!response.ok || !response.body) {
  console.error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  process.exit(1);
}

await fsp.mkdir(path.dirname(target), { recursive: true });

// Written beside the target and renamed, so an interrupted download cannot
// leave a truncated file that later looks like a corrupt model.
const temporary = `${target}.partial`;
await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));

const { size } = await fsp.stat(temporary);
if (size < MIN_PLAUSIBLE_BYTES) {
  await fsp.rm(temporary, { force: true });
  console.error(`Downloaded only ${size} bytes — this is probably a Git LFS pointer, not the model.`);
  process.exit(1);
}

await fsp.rename(temporary, target);

console.log(`Done: ${size} bytes.`);
console.log('Enable it with SUBJECT_TRACKER=face (and `npm i onnxruntime-node` if it is not installed).');
