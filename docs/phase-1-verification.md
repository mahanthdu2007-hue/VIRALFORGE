# Phase 1 verification log

Everything below was run on the development machine, not inferred.

**Environment:** Windows 11 · Node v24.13.1 · npm 11.8.0 · FFmpeg/ffprobe 8.1.1 (gyan.dev essentials)

## Commands run

| Command                | Result                                                          |
| ---------------------- | --------------------------------------------------------------- |
| `npm install`          | 371 packages, no vulnerabilities reported                        |
| `npm run doctor`       | Exit 0 — ffmpeg 8.1.1, ffprobe 8.1.1, provider `mock`            |
| `npm run typecheck`    | Clean (`tsc --noEmit`, strict + `noUncheckedIndexedAccess`)      |
| `npm run lint`         | Clean (ESLint flat config, `next/core-web-vitals` + typescript)  |
| `npm test`             | **158 passed / 158**, 8 files                                    |
| `npm run build`        | Compiled; 2 static routes, 6 dynamic API routes                  |
| `npm start`            | Server ready on the configured port                              |

## Live API checks

Against a real 1920×1080 / 30fps / h264+aac MP4 generated with
`ffmpeg -f lavfi -i testsrc ... -f lavfi -i sine ...`.

| Request                                              | Result                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /`                                              | 200, page renders                                                       |
| `GET /api/system`                                    | 200, `ffmpeg.available: true`, versions reported, secrets shown as booleans |
| `POST /api/videos` (real MP4, `x-filename` encoded)  | **201**, real ffprobe metadata: `durationSec 6`, `1920×1080`, `fps 30`, `hasAudio true`, `h264`/`aac` |
| `GET /api/videos/:id`                                | 200                                                                     |
| `POST /api/analysis` (valid video)                   | **501** `not_implemented`, `plannedPhase: "Phase 2"`                     |
| `POST /api/videos` with `notes.txt`                  | 400 `validation` / `unsupported_extension`                              |
| `POST /api/videos`, non-video bytes named `.mp4`     | 422 `media` / `command_failed`; partial file deleted                     |
| `GET /api/videos/:absent`                            | 404 `not_found` / `video_not_found`                                     |
| `GET /api/jobs/:absent`                              | 404 `not_found` / `job_not_found`                                       |
| `GET /api/jobs/not-a-uuid/status`                    | 400 `validation` / `invalid_job_id`                                     |
| `POST /api/analysis` `clipCount: 99`                 | 400 `validation`, issue reported on `clipCount`                          |
| `POST /api/analysis` malformed JSON                  | 400 `validation` / `invalid_json`                                       |

## Defects found during verification, and fixed

**1. Client bundle pulled in `node:path`** — `Dropzone` imported the accepted-extension list from
`validation/schemas.ts`, which imported `node:path`; webpack failed the build with
`UnhandledSchemeError`. Split the dependency-free upload policy into `validation/media-types.ts`.
Caught by `npm run build`.

**2. Every 404 and 422 was reported as 500 `unexpected`.** `isAppError` used `instanceof`. The Next
dev server compiles each route into its own module graph, so services cached on `globalThis`
(`runtime.ts`) threw `AppError`s built from a different copy of the class than the route catching
them. `AppError` now carries `Symbol.for('viralforge.AppError')` and `isAppError` checks that brand.
Caught by probing the live API; regression test added in `tests/errors.test.ts`.

**3. Media errors leaked absolute filesystem paths to clients.** The 422 body contained the full
ffprobe argv and raw stderr, including `E:\PROJECTS\...\storage\uploads\...`. `AppError` now separates
`details` (wire) from `logDetails` (log only), and `pathRedactor` rewrites any absolute path we passed
down to its basename in client-facing text. Tests added in `tests/errors.test.ts` and
`tests/media.test.ts`.
