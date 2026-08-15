-o#!/usr/bin / env node
/**
 * Preflight check: is this machine ready to run ViralForge?
 *
 * Deliberately standalone plain JS with no imports from `src/` — it must work
 * before anything is built and without a TypeScript loader. The app itself uses
 * `src/media/ffmpeg.ts` for the same detection; this script exists so a human
 * can answer "is FFmpeg there?" in one command.
 *
 *   npm run doctor
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// Load .env.local / .env if present, so custom FFMPEG_PATH is honoured.
for (const file of ['.env.local', '.env']) {
  const full = path.join(ROOT, file);
  if (existsSync(full)) process.loadEnvFile(full);
}

const version = (bin) =>
  new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, detail: error.code === 'ENOENT' ? 'not found on PATH' : error.message });
        return;
      }
      const match = /^(?:ffmpeg|ffprobe) version (\S+)/im.exec(stdout);
      resolve({ ok: true, detail: match?.[1] ?? 'unknown version' });
    });
  });

const line = (label, { ok, detail }) => `${ok ? '  ok  ' : ' FAIL '} ${label.padEnd(22)} ${detail}`;

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';

const [node, ffmpeg, ffprobe] = await Promise.all([
  Promise.resolve({ ok: true, detail: process.version }),
  version(ffmpegPath),
  version(ffprobePath),
]);

const secrets = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'NVIDIA_API_KEY'];

console.log('\nViralForge AI 2.0 — environment check\n');
console.log(line('node', node));
console.log(line(`ffmpeg (${ffmpegPath})`, ffmpeg));
console.log(line(`ffprobe (${ffprobePath})`, ffprobe));
console.log(line('AI_PROVIDER', { ok: true, detail: process.env.AI_PROVIDER || 'mock (default)' }));

for (const key of secrets) {
  // Presence only. The value is never printed.
  console.log(line(key, { ok: true, detail: process.env[key] ? 'configured' : 'not set (Phase 2)' }));
}

const ready = ffmpeg.ok && ffprobe.ok;
console.log(`\n${ready ? 'Media toolchain ready.' : 'FFmpeg is missing — uploads will be rejected.'}\n`);

process.exit(ready ? 0 : 1);
