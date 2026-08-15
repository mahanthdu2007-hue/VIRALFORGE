# Architecture

Companion to the README. This document explains *why* the code is shaped the way it is, so Phase 2
extends the foundation instead of working around it.

## Layers

```
┌─ app/            route handlers + React pages      (HTTP and rendering only)
├─ components/     UI                                 (no business rules)
├─ runtime.ts      composition root                   (the only place that picks implementations)
├─ ai/  media/  jobs/  storage/  validation/          (services, all behind interfaces)
├─ config/  lib/   env parsing, logger, errors        (cross-cutting)
└─ domain/         types + pure rules                 (imports nothing but itself)
```

Dependencies point inward. `domain/` has no I/O, no `process.env`, no FFmpeg, no network — which is
why every domain rule is testable in microseconds.

## Memory discipline

The product must run comfortably on a 16 GB laptop while handling hour-long 1080p source video. The
rules that make that true:

1. **A video is never a `Buffer`.** `LocalFileStore.writeStream` pipes the request body to disk with a
   byte counter that aborts mid-stream past `MAX_UPLOAD_MB` and deletes the partial file.
2. **`multipart/form-data` is banned on the upload path.** Next's `formData()` materialises the whole
   file. The raw body is streamed instead, with the filename percent-encoded in `x-filename`.
3. **Media transforms are subprocesses over files.** `runCommand` captures only text output, capped at
   4 MB, with a timeout. FFmpeg's own memory is bounded by its filter graph, not by video length.
4. **AI providers receive paths, not bytes.** `TranscriptionRequest.audioPath`,
   `FramingRequest.sampleFramePaths`. A provider that needs the file uploads it itself, streaming.

Phase 2 must keep these rules. Concretely: extract audio to a temp WAV/M4A in `storage/work`, and cut
clips with `-ss`/`-to` seeks rather than decoding the whole timeline.

## Job state machine

`src/domain/job-state.ts` declares `JOB_TRANSITIONS` as an adjacency map. It is data, not `if`
statements, so tests can assert properties over the whole graph — every non-terminal state can fail
or cancel, terminal states have no successors, no successor is outside the enum.

`src/jobs/transitions.ts` holds the operations, all pure:

| Function          | Guarantee                                                              |
| ----------------- | ---------------------------------------------------------------------- |
| `transitionJob`   | Throws `illegal_job_transition` on an undeclared move; appends history  |
| `setJobProgress`  | Monotonic — progress never rewinds                                      |
| `failJob`         | Captures `kind`/`code`; a no-op once the job is terminal                |
| `cancelJob`       | Same terminal guard, so a late cancel cannot overwrite a completion     |

One enum serves both job types; a type simply never visits states that do not apply to it. `QUEUED`
can go straight to `RENDERING` because a render job starts there.

## Error taxonomy

`kind` determines the HTTP status and who is at fault:

| Kind         | Status | Meaning                                                   |
| ------------ | ------ | --------------------------------------------------------- |
| `validation` | 400    | The caller sent something unacceptable                     |
| `not_found`  | 404    | A referenced entity does not exist                         |
| `media`      | 422    | The file or the toolchain is the problem                   |
| `ai`         | 502    | A provider failed, refused, or returned something unusable |
| `processing` | 500    | A pipeline stage failed                                    |
| `rendering`  | 500    | The final encode/mux failed                                |
| `unexpected` | 500    | Never thrown deliberately — only produced by wrapping      |

`handleRoute` wraps every route body. 5xx and `unexpected` are logged with a stack; 4xx are logged at
`warn`. Nothing is swallowed, and `toAppError` never discards the original (`cause` is preserved).

### `AppError` is branded, not `instanceof`-checked

A trap worth remembering: the Next dev server compiles each route into its own module graph, so
`lib/errors` is instantiated more than once. Services cached on `globalThis` (see `runtime.ts`) throw
errors built from a *different* copy of the class than the route catching them, and `instanceof`
returns false. That silently downgraded every 404 and 422 to `unexpected`/500.

`AppError` therefore carries `Symbol.for('viralforge.AppError')` and `isAppError` checks that brand.
There is a regression test for it in `tests/errors.test.ts`.

## AI provider abstraction

```
AiProvider
├── id, displayName, capabilities[], health()
├── transcription?  : TranscriptionCapability   transcribe(audioPath, durationSec) → TranscriptionDraft
├── clipDiscovery?  : ClipDiscoveryCapability   discoverClips(segments, …)         → CandidateClipDraft[]
└── framing?        : FramingCapability         planFraming(frames, …)             → FramingDraft
```

Three deliberate choices:

- **Capabilities are declared and checked.** `requireTranscription(provider)` throws
  `capability_unsupported` rather than letting an `undefined` method surface later. A provider that
  can transcribe but not reason about framing composes fine.
- **Providers return drafts.** Plain data, no ids, no timestamps, no persistence. The pipeline assigns
  identifiers and validates. This keeps providers ignorant of the domain's identity model, and makes
  them trivial to fake.
- **The registry is the only place concrete providers are named.** Adding Gemini is one entry in
  `FACTORIES` plus an adapter file. Requesting an unregistered provider fails loudly with
  `provider_not_available` — it does not silently fall back to the mock.

`transcribe` deliberately takes a **path**, which is what leaves room for a local Whisper sidecar
without reshaping anything (see the README's note on Python).

## Trusting nothing the model returns

Discovery output crosses four gates before it can be stored:

1. **JSON Schema** (`strict: true`) constrains what the model may emit.
2. **Zod** re-checks what actually arrived — structured output is a strong hint, not a guarantee.
3. **`validateCandidates`** checks ranges, duration, transcript coverage, signals and confidence.
4. **The verbatim guard** checks `hookQuote` against the transcript text the candidate spans.

A candidate that fails any gate is rejected with a machine-readable code and logged individually —
those log lines are the audit trail for the verbatim guarantee. It is never repaired: inventing a
replacement quote or nudging a bad boundary is exactly the quiet fabrication this project promises
not to do. One bad candidate does not fail the run.

The same applies to transcription: `normaliseTranscriptDraft` rejects impossible timings outright and
limits itself to formatting fixes (ordering, whitespace, a sub-second tail clamp). It never edits the
words. Word timings are the one exception where bad entries are dropped rather than fatal — a missing
word timing costs subtitle precision, not correctness.

## Adding a real provider (Phase 2 recipe)

1. `src/ai/providers/gemini.ts` exporting `createGeminiProvider(config): AiProvider`.
2. Read the key from `config.ai.keys.gemini`; return `health() → ok:false` with a clear reason when
   absent, rather than throwing at construction.
3. Declare only the capabilities actually implemented.
4. Register it in `FACTORIES`.
5. Map SDK failures to `aiError(...)`. No SDK type may appear in the return values.
6. Verbatim guard: assert returned `hookQuote` text really occurs in the transcript. The product
   promise is that nothing is rewritten, and that should be enforced in code, not trusted.

## Persistence

SQLite through Node's built-in `node:sqlite` — durable records for no dependency and no server. The
database holds records and paths; media bytes stay on disk under `STORAGE_DIR`.

Schema changes are appended to `MIGRATIONS` in `src/storage/db.ts` and applied by comparing SQLite's
own `user_version`. Never edit a released migration.

Where JSON columns are used (`history_json`, `signals_json`, `words_json`, `result_json`) it is
because those values are read and written whole and never queried into. Segments *are* a real table,
because later phases will want to select by time range.

WAL mode is on so status polling can read while a job writes.

## Background jobs

`JobRunner` is a FIFO queue with a concurrency cap, in the same Node process. Analysis takes minutes,
so it cannot run inside the HTTP request; `POST /api/analysis` creates the job, enqueues it and
returns 202.

A broker would be more moving parts than the workload justifies — FFmpeg plus one provider call is
not something that benefits from distribution. The cap is the part that matters on a 16 GB machine:
an unbounded runner would put several FFmpeg processes up at once.

The trade-off is that queued work lives in memory. Startup handles both halves of that:
`recoverInterrupted` fails jobs a previous process left mid-run (they cannot be resumed safely), and
`resumeQueued` re-enqueues jobs that never started (they can, because no work was done).

## Analysis pipeline

`runAnalysis` takes an `AnalysisDeps` bag rather than reaching for the runtime, so tests assemble a
pipeline from an in-memory database and a stub provider with no server and no API key.

It never throws for a pipeline failure — the job is moved to FAILED with the reason recorded, because
the job record is how the caller learns what happened. Each stage persists before the next begins, so
a crash leaves the job's true position visible. Extracted audio is deleted in a `finally`, on success
and failure alike.

The provider declares the audio it wants (`TranscriptionCapability.audioSpec`) and the pipeline asks
the media engine for exactly that. Encoding decisions therefore live with the provider that has the
constraint, not in the media engine and not in the pipeline.
