# Phase 2 verification log

Everything below was run on the development machine, not inferred.

**Environment:** Windows 11 · Node v24.13.1 · FFmpeg/ffprobe 8.1.1 · `node:sqlite` (experimental
warning only, no flag needed) · `libopus` present.

## Commands run

| Command             | Result                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `npm run typecheck` | Clean                                                                |
| `npm run lint`      | Clean                                                                |
| `npm test`          | **310 passed / 310**, 15 files                                       |
| `npm run build`     | Compiled; 2 static routes, 8 dynamic API routes                      |
| `npm start`         | Ready in ~0.6s                                                       |

## Live run against a real fixture

Fixture: a 100-second 640×360 15fps H.264 + AAC MP4 generated with FFmpeg (`testsrc` + `sine`).
Provider: `mock` (deterministic, offline). Database: `storage/viralforge.db`.

| Step | Result |
| ---- | ------ |
| `POST /api/videos` | `201`, probed `durationSec: 100`, `hasAudio: true` |
| `POST /api/analysis` | **`202`**, job `QUEUED`, `statusUrl` returned — request did not block |
| Polling `/status` | `ANALYZING (15)` → `COMPLETED (100)` |
| Job history | `QUEUED → ANALYZING → TRANSCRIBING → FINDING_CLIPS → COMPLETED` |
| **Audio extraction** | Logged `sizeBytes: 3200312, format: wav, sampleRateHz: 16000` — exactly 100s × 16 kHz × 2 bytes mono + WAV header |
| **Transcript persisted** | 20 segments, `hasWordTimings: true`, 5 words on segment 1, `source: mock/mock-v1` |
| **Candidates persisted** | 2 candidates, `[0–40]` and `[50–90]`, both 40s (inside the 20–60s window), 8 segment ids each, `score: null` (scoring is a later phase) |
| **Verbatim guard** | Every stored `hookQuote` occurs in its stored `text` — checked live on both candidates |
| **Work file cleanup** | After the run, `storage/` contains only `viralforge.db*` and the uploaded MP4. No extracted audio left behind. |

### Restart persistence

The server was stopped and restarted, then queried for records written by the *previous* process:

```
video:      fixture.mp4 duration=100s
job:        state=COMPLETED history=QUEUED->ANALYZING->TRANSCRIBING->FINDING_CLIPS->COMPLETED
transcript: available=True segments=20 (5 words on segment 1)
candidates: count=2, all quotes traceable: True
```

### Failure paths

| Case | Result |
| ---- | ------ |
| Analysis on a video with no audio track | `422 media/no_audio_stream`, refused before a job was created |
| `AI_PROVIDER=openai` with no key: `GET /api/system` | `ok: false`, `"OPENAI_API_KEY is required…"` |
| `AI_PROVIDER=openai` with no key: `POST /api/analysis` | `502 ai/provider_not_configured`. **No job created, no transcript written — no silent fallback to mock.** |

The verbatim guard's rejection behaviour is covered by tests rather than the live run, because the
mock provider quotes the transcript correctly by construction: `tests/candidates.test.ts` (fabricated,
paraphrased, and real-but-out-of-window quotes) and `tests/pipeline.test.ts` (a provider returning a
fabricated quote — the run completes, the candidate is rejected, nothing is persisted).

## Defects found during verification, and fixed

**1. A client component pulled `node:path` into the browser bundle** (carried over from Phase 1's
pattern). Not re-triggered this phase; the split in `validation/media-types.ts` held.

**2. FFmpeg's version banner masked every extraction error.** `runCommand` builds its message from the
first line of stderr, and `ffmpeg` prints its banner there, so `no_audio_stream` detection never
matched and a missing audio track surfaced as a generic `command_failed`. Fixed by adding
`-hide_banner -loglevel error` to the extraction args, and by matching against the captured stderr in
`logDetails` rather than the summary message. Caught by `tests/audio-extraction.test.ts`.

**3. A test misused `MediaService.probe` on extracted audio.** `probe` is video-only by design — it
rejects a file with no video stream — so asserting on the extracted WAV through it failed. The test
was wrong, not the code; it now calls ffprobe directly through a local helper. `probe` stays
video-only, which is what the pipeline needs.

**4. The Phase 1 UI would have broken on the new `202`.** It was written to expect `501` from
`/api/analysis` and would have shown "Unexpected response (202)". Wired to the real job instead:
`useJobStatus` polls `/api/jobs/:id/status` until terminal, and the existing pipeline tracker now
reflects true job state. No redesign — the same components, connected to real data.
