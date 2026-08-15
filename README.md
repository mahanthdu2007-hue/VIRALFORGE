# ViralForge AI 2.0

Turn a long-form video into a handful of Shorts that are actually worth watching.

You upload a long video. ViralForge transcribes the original audio, finds the moments that land,
assembles coherent 30–40 second Shorts, reframes them to 9:16, burns in synchronised subtitles and
renders 1080×1920 output you can preview and download.

**Three rules the product will never break:**

1. No AI voice. Ever. The audio in a Short is the audio you uploaded.
2. No rewritten dialogue. Subtitles are verbatim; only segmentation and line breaking are ours.
3. AI decides *what to keep and how to frame it* — it does not generate content.

> **Status: Phase 2 (transcription and moment discovery).** A video can be uploaded, probed, have its
> audio extracted, be transcribed with word-level timings, and have candidate moments discovered,
> validated and persisted — all through a real background job, all stored in SQLite, all surviving a
> restart. Clip construction, scoring, subtitles, reframing and rendering are not built yet. Nothing
> in this repository fakes video processing.

---

## Pipeline

```
upload → analyze → transcribe → understand → find viral moments → select best 3
       → construct 30–40s Shorts → smart 9:16 reframe → subtitles → 1080p render → preview
```

| Stage             | Job state        | Status                                                        |
| ----------------- | ---------------- | ------------------------------------------------------------- |
| Upload            | `UPLOADING`      | **Done** — streamed to disk                                    |
| Analyze           | `ANALYZING`      | **Done** — ffprobe metadata, then FFmpeg audio extraction      |
| Transcribe        | `TRANSCRIBING`   | **Done** — validated, persisted, word timings where available  |
| Find moments      | `FINDING_CLIPS`  | **Done** — candidates discovered, verbatim-checked, persisted  |
| Build Shorts      | `BUILDING_CLIPS` | Domain model only                                              |
| Render            | `RENDERING`      | Domain model only                                              |

---

## Stack

| Concern     | Choice                                    | Why                                                         |
| ----------- | ----------------------------------------- | ----------------------------------------------------------- |
| UI          | Next.js 15 (App Router), React 19, TS     | One framework for UI and API; strict types across the board  |
| Styling     | Tailwind CSS v4                           | Design tokens in CSS, no runtime cost                        |
| API         | Next route handlers (Node runtime)        | Same process as the UI; no second service to operate         |
| Media       | FFmpeg + ffprobe as child processes       | The only serious option; streams, never buffers              |
| Validation  | Zod                                       | One schema library for env, request bodies and AI output     |
| Tests       | Vitest                                    | Fast, no transpile config of its own                         |
| Persistence | SQLite via built-in `node:sqlite`         | Durable records with zero dependencies and no server         |
| Jobs        | In-process FIFO queue with a concurrency cap | Minutes-long work off the request path, no broker to run  |
| ASR         | OpenAI `whisper-1` or NVIDIA `parakeet-tdt-0.6b-v2` (pluggable) | Both give documented word-level timestamps |

### Why there is no Python service

The suggested stack included a Python processing tier. It is not here, deliberately:

- Every AI provider on the roadmap (Gemini, OpenAI, NVIDIA) is a **remote API** — HTTP for chat and
  for OpenAI's ASR, gRPC for NVIDIA's Riva ASR. Both have first-class pure-JavaScript clients, so
  calling them from TypeScript is not worse than calling them from Python.
- All media work is **FFmpeg subprocesses over files on disk**. That is language-agnostic.
- A second runtime means a second dependency tree, a second process to supervise, and an IPC layer —
  real cost, for no capability we need in Phase 1.

The one genuine Python advantage is **local ASR** (`faster-whisper`). That is why transcription sits
behind `TranscriptionCapability` (see `src/ai/types.ts`), which takes an audio *path* and returns
timed segments. A local Whisper sidecar, a `whisper.cpp` binary, or a cloud API all satisfy that
interface identically. If Phase 2 wants a local model, it slots in as one more provider — no
business logic changes. Note also that this machine runs Python 3.14, which the current ML wheels do
not reliably support yet.

---

## Architecture

```
src/
├── app/                 Next.js App Router
│   ├── page.tsx         Studio page
│   └── api/             Route handlers (thin: validate → delegate → respond)
├── components/          UI (Studio, Dropzone, Pipeline, Results, SystemBar, brand, ui primitives)
├── domain/              Types and pure rules, including the verbatim guard. No I/O.
├── ai/                  Provider abstraction + registry + mock and OpenAI providers
├── media/               FFmpeg wrapper, ffprobe parsing, audio extraction, MediaService
├── jobs/                Job store, pure state-machine transitions, background runner
├── pipeline/            The analysis pipeline and its declared dependencies
├── storage/             SQLite schema + repositories, streaming file store
├── validation/          Zod schemas, transcript and candidate validation
├── config/              Env parsing (the only reader of process.env)
├── lib/                 Logger, error taxonomy, HTTP helpers, formatting
└── runtime.ts           Composition root — the only place implementations are chosen
```

Dependency direction is strictly inward: `app` → `runtime` → services → `domain`. The domain layer
imports nothing but itself and the error taxonomy.

### Design decisions worth knowing

**Low RAM by construction.** A video is never a `Buffer`. Uploads stream from the request body to
disk (`LocalFileStore.writeStream`); FFmpeg reads back from disk; only textual output (probe JSON,
version banners) is ever captured, and that capture is bounded. `multipart/form-data` is avoided
because Next's `formData()` would buffer the whole file — the raw body is streamed with the filename
in an `x-filename` header instead.

**Job states are a declared machine.** `JOB_TRANSITIONS` in `src/domain/job-state.ts` is an explicit
adjacency map. An illegal move throws `illegal_job_transition` rather than corrupting a job. All
transition functions are pure and return new objects.

**Errors are categorised, never swallowed.** Every deliberate failure is an `AppError` with a `kind`
(`validation`, `media`, `ai`, `processing`, `rendering`, `not_found`, `unexpected`) that determines
its HTTP status. `unexpected` is only ever produced by wrapping something we did not anticipate, and
it is always logged with its stack.

**Providers are swappable, and never silently substituted.** Business logic depends on `AiProvider`
and asks the registry for a capability (`requireTranscription(provider)`), which throws if the
provider does not declare it. Providers take file paths and return plain drafts — no ids, no
persistence, no SDK types leaking out. A misconfigured real provider fails the request with
`provider_not_configured`; it never falls back to the mock, because silently returning placeholder
analysis is worse than an error.

**Nothing the model says is trusted.** Discovery output passes a JSON Schema on the way out of the
model and a Zod schema on the way in, then per-candidate validation, then the verbatim guard. An
invalid candidate is rejected and logged with a reason; it is never repaired. One bad candidate does
not fail the run.

### The verbatim guard

`src/domain/verbatim.ts` is the enforcement point for "never rewrite the speaker", and it is a
deterministic string check — an LLM asked "is this quote faithful?" is precisely the component not
trusted here.

`verifyQuote(quote, sourceText)` normalises both sides (NFKC, case folding, apostrophe removal, every
other non-alphanumeric run collapsed to one space) and requires the quote to occur in the source on
whole-word boundaries. Punctuation is dropped rather than canonicalised, because ASR punctuation is a
model guess: "it works, really" and "it works really" are the same speech. The normalisation is only
ever a comparison key — the stored transcript is untouched by it.

A `CandidateClip` cannot exist without having passed it: `validateCandidates` verifies `hookQuote`
against the transcript text the candidate actually spans, so a quote that is real but comes from
elsewhere in the video is rejected too.

---

## Setup

Requirements: **Node ≥ 20.9** and **FFmpeg** (both `ffmpeg` and `ffprobe`) on `PATH`.

```bash
npm install
cp .env.example .env.local     # Windows: copy .env.example .env.local
npm run doctor                 # confirms FFmpeg, Node, provider config
```

`npm run doctor` exits non-zero if FFmpeg is missing.

### Environment variables

All optional in Phase 1 — the defaults run the app on the mock provider.

| Variable         | Default   | Purpose                                                       |
| ---------------- | --------- | ------------------------------------------------------------- |
| `GEMINI_API_KEY` | —         | Not implemented yet. Blank is treated as unset.               |
| `OPENAI_API_KEY` | —         | Required when `AI_PROVIDER=openai`.                           |
| `NVIDIA_API_KEY` | —         | Required when `AI_PROVIDER=nvidia`. The only key that mode needs. |
| `AI_PROVIDER`    | `mock`    | `mock` \| `openai` \| `nvidia` implemented; `gemini` fails loudly. |
| `OPENAI_TRANSCRIPTION_MODEL` | `whisper-1`  | Needs `verbose_json` with word timestamps.       |
| `OPENAI_DISCOVERY_MODEL`     | `gpt-4o-mini`| Needs strict structured outputs.                 |
| `NVIDIA_TRANSCRIPTION_MODEL` | `nvidia/parakeet-tdt-0.6b-v2` | English ASR with punctuation and word timestamps. |
| `NVIDIA_DISCOVERY_MODEL`     | `nvidia/nemotron-3.5-lightning-30b-a3b` | Also used for refinement. |
| `NVIDIA_ASR_ENDPOINT`        | `grpc.nvcf.nvidia.com:443` | `host:port` of the Riva gateway, not a URL. |
| `NVIDIA_ASR_FUNCTION_ID`     | —         | NVCF function id, only for a model the app has no id for.      |
| `FFMPEG_PATH`    | `ffmpeg`  | Absolute path, or blank to resolve from `PATH`.                |
| `FFPROBE_PATH`   | `ffprobe` | As above.                                                      |
| `STORAGE_DIR`    | `storage` | Uploads, work files and renders. Relative to the project root. |
| `DATABASE_FILE`  | `viralforge.db` | SQLite file inside `STORAGE_DIR`. `:memory:` is honoured. |
| `MAX_UPLOAD_MB`  | `2048`    | Rejected before any bytes are written, and again mid-stream.    |
| `JOB_CONCURRENCY`| `1`       | Analysis jobs at once. Each owns an FFmpeg process.             |
| `MAX_CANDIDATES` | `12`      | Ceiling on moments discovery may return per video.              |
| `SUBJECT_TRACKER`| `center`  | `center` \| `face` \| `luminance` \| `none`. See below.         |
| `SUBJECT_DETECTOR_MODEL_PATH` | `<STORAGE_DIR>/models/face_detection_yunet_2023mar.onnx` | Weights for `face`. |
| `SUBJECT_DETECTOR_FPS` | `2` | Frames sampled per second of source. The main cost lever.        |
| `SUBJECT_DETECTOR_MAX_FRAMES` | `240` | Hard ceiling on sampled frames per clip.              |
| `SUBJECT_DETECTOR_MAX_EDGE_PX` | `640` | Longest edge a frame is decoded at.                  |
| `SUBJECT_DETECTOR_MIN_CONFIDENCE` | `0.6` | Below this, a detection is not a subject.         |
| `LOG_LEVEL`      | `info`    | `trace` \| `debug` \| `info` \| `warn` \| `error`.              |

Secrets are read only by `src/config/env.ts` and are never logged: `describeConfig()` reduces each
key to a boolean.

### Subject tracking (optional)

The 9:16 crop follows whatever `SubjectTracker` reports. By default that is `center`, which assumes
the subject is in the middle of the frame — deterministic, instant, and what the test suite runs on.

`face` replaces it with real detection: the **YuNet** face detector, run locally on the CPU through
ONNX Runtime. Two things are needed, and neither is in the repository:

```bash
npm i onnxruntime-node                   # optional dependency, ~259 MB on disk
node scripts/fetch-subject-model.mjs     # 232 KB of weights → storage/models/
SUBJECT_TRACKER=face npm run dev
```

The weights land under `STORAGE_DIR`, which is already git-ignored. They come from
[OpenCV's model zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)
(MIT licensed) and are stored there with Git LFS — the script uses the LFS media URL, because the
plain `raw.githubusercontent.com` one returns a 131-byte pointer file that downloads happily and
then fails to load.

What it costs: ~55 MB resident for the runtime plus ~70 MB while inferring, and roughly 20 ms per
sampled frame on a laptop CPU. At the default 2 fps a 30-second clip is about 60 frames, so ~1.5 s
of detection — bounded by `SUBJECT_DETECTOR_MAX_FRAMES` regardless of clip length. The model loads
on the first frame and is shared process-wide, so concurrent jobs hold one copy.

**No frame ever leaves the machine.** Detection is local; nothing in the tracking layer makes a
network call. The only download is the one-off `fetch-subject-model.mjs` above.

If either prerequisite is missing — no package, no weights — selection degrades to `center` and logs
the reason once rather than failing. The same is true per clip: a detector that errors, or footage
with nobody in it, produces no observations, and `buildCropPath` falls back to a static centre crop.

`luminance` is a third option that needs nothing installed: it follows the brightest connected region
of the frame. It is a saliency heuristic, not recognition — worth having on a lit subject against a
dark set, and it is what the end-to-end test uses so that a plain `npm test` exercises the real
video-to-render path with no downloads.

---

## Commands

```bash
npm run dev          # dev server on http://localhost:3000
npm run build        # production build (also type-checks and lints)
npm start            # serve the production build
npm run doctor       # environment / FFmpeg check
npm test             # vitest run
npm run test:watch   # vitest watch
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
```

---

## API

| Endpoint                    | Behaviour                                                                   |
| --------------------------- | -------------------------------------------------------------------------- |
| `POST /api/videos`          | Raw body streamed to disk, filename in `x-filename` (percent-encoded), then probed with ffprobe. `201` with the `VideoAsset`. Unprobeable uploads are deleted and rejected `422`. |
| `GET /api/videos/:id`       | The stored record and its metadata. `404` if unknown.                       |
| `POST /api/analysis`        | Creates an analysis job, queues it, returns **`202`** with the job and a `statusUrl`. Refuses up front (`422`/`502`) if the video has no audio, FFmpeg is missing, or the provider is unconfigured. |
| `GET /api/jobs/:id`         | Full job record with history, plus transcript availability and candidate count. |
| `GET /api/jobs/:id/status`  | Small polling payload: state, label, progress, terminal flag, failure.       |
| `GET /api/videos/:id/transcript`  | The persisted verbatim transcript with word timings where available. |
| `GET /api/videos/:id/candidates`  | Discovered moments; every `hookQuote` has passed the verbatim guard. |
| `GET /api/system`           | FFmpeg versions, active provider and health, redacted config.               |

Errors share one envelope:

```json
{ "error": { "kind": "validation", "code": "unsupported_extension", "message": "…", "details": {} } }
```

---

## Tests

716 tests across 31 files. No test needs an API key or a network connection, and none downloads a
model: the one test that needs the face-detection weights skips itself when they are absent.

| File                                | Covers                                                              |
| ----------------------------------- | ------------------------------------------------------------------- |
| `tests/config.test.ts`              | Env defaults, blank placeholders, coercion, malformed input, secret redaction |
| `tests/errors.test.ts`              | Error taxonomy → status, unknown throws, log/wire detail split, structured logging |
| `tests/domain.test.ts`              | Time ranges, unit scores, transcript text, clip-plan duration, crop-plan validity |
| `tests/verbatim.test.ts`            | **The verbatim guard**: exact, punctuation, whitespace, case, fabricated, partial, boundaries |
| `tests/job-state.test.ts`           | Every state, the happy path, illegal transitions, failure capture, SQLite round trips |
| `tests/ai-provider.test.ts`         | Registry resolution, no-fallback on a missing key, capability guards, mock behaviour |
| `tests/openai-provider.test.ts`     | OpenAI adapter contract against a stub `fetch`: request shape, mapping, every failure mode |
| `tests/validation.test.ts`          | Accepted formats, upload gating, filename sanitisation, request schemas |
| `tests/transcript-validation.test.ts` | Ordering, clamping, overlap, empty text, bad timestamps, word-timing handling |
| `tests/candidates.test.ts`          | Candidate validation and the verbatim boundary in context             |
| `tests/storage.test.ts`             | Streaming writes, mid-stream abort, path-escape guard, video repository |
| `tests/persistence.test.ts`         | Schema migration, foreign keys, transcript/candidate round trips, **restart durability** |
| `tests/pipeline.test.ts`            | Full pipeline, each failure mode, rejection of fabricated candidates, runner concurrency, restart recovery |
| `tests/media.test.ts`               | **Real FFmpeg detection**, version parsing, ffprobe → `MediaMetadata`  |
| `tests/audio-extraction.test.ts`    | **Real FFmpeg extraction**: mono 16 kHz, determinism, Opus, no-audio, cleanup |
| `tests/subject-detector.test.ts`    | YuNet decoding and letterboxing from hand-built tensors, luminance blobs, track association (multiple people, lost detections, low confidence, entering/leaving), tracker selection and its fallbacks — no model, no video |
| `tests/subject-detector-video.test.ts` | **Real video end to end**: bounded frame sampling, detections that follow a moving subject, a tracked `CropPlan`, and a rendered 9:16 clip read back with ffprobe |
| `tests/subject-detector-model.test.ts` | **Real weights**, skipped unless present: lazy single-copy loading, well-formed boxes, selector behaviour. Set `SUBJECT_DETECTOR_TEST_IMAGE` to also assert a positive detection on a real face |

---

## Status

**Phase 1 — foundation (done).** Project structure, validated config, domain models, the job-state
machine, the provider abstraction, the media engine, structured logging, the error taxonomy, the API
surface and the Studio UI.

**Phase 2 — transcription and moment discovery (done).**

- SQLite persistence via built-in `node:sqlite`, with versioned migrations. Videos, jobs,
  transcripts, segments (with word timings) and candidates all survive a restart.
- FFmpeg audio extraction: mono, 16 kHz, metadata-stripped and byte-deterministic, format chosen by
  whatever the transcription provider declares it wants.
- A real transcription provider (OpenAI) returning segment and word-level timings, behind the
  existing `TranscriptionCapability`.
- Transcript validation that rejects impossible timings and normalises only formatting.
- The verbatim guard, and candidate validation built on it.
- Moment discovery producing 20–60s candidates with structured signals, a reason and a confidence.
- A background job runner with a concurrency cap, driving
  `QUEUED → ANALYZING → TRANSCRIBING → FINDING_CLIPS → COMPLETED`, and `FAILED` on any error.
- Restart recovery: interrupted jobs are marked failed, never-started jobs are re-queued.

**Not built yet** — clip construction to 30–40s, top-3 selection, viral scoring, subtitles, smart
cropping, 9:16 rendering, preview and download.

### Known limitations

- The OpenAI adapter is verified against a stub `fetch`, not against the live API — no key was
  available. Its request shape, response mapping and failure handling are pinned by tests; the model
  names are configurable precisely because they may need to change.
- Audio longer than the provider's upload ceiling fails with `audio_too_large` rather than being
  chunked. At 24 kbps Opus that is roughly three hours.
- The job queue lives in memory. Job *records* are durable and a restart re-queues anything that had
  not started, but a job interrupted mid-run is marked failed rather than resumed.
- Uploaded videos are never garbage-collected. Intermediate audio is deleted after every run,
  including failures.
- `MediaService.probe` is deliberately video-only; it rejects audio-only files.

### Next phase

**Phase 3 — clip construction and scoring.** Turn candidates into coherent 30–40s `ClipPlan`s with
boundaries snapped to word timings, then score and rank them to select the best three. The verbatim
guard must stay the gate on any text a clip carries.
