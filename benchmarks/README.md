# Clip-quality benchmark

`clip-quality.baseline.json` is the last agreed output of the clip stage on five
representative transcripts — podcast/interview, educational explainer,
storytelling, opinion/debate, and fast conversation.

It exists so a change to scoring, boundary snapping, preselection or ranking can
be **read** rather than guessed at: the diff shows which candidates changed
promise, which clips moved on the timeline, what every score component did, and
which three Shorts came out.

## Running it

```bash
npm run bench          # compare against the baseline
```

The fixtures live in `src/benchmark/fixtures/`, the harness in
`src/benchmark/harness.ts`. Everything is offline, deterministic and free: no
provider is called, no audio is decoded, nothing is rendered, and no database is
touched. The harness only calls production code — it has no scoring logic of its
own.

## Re-generating

A failing comparison is the benchmark doing its job. Read the diff first, decide
the change is intended, then:

```bash
VIRALFORGE_BENCH_UPDATE=1 npm run bench          # bash
$env:VIRALFORGE_BENCH_UPDATE=1; npm run bench    # PowerShell
```

Commit the regenerated baseline in the same change as the behaviour that moved
it, so the two are reviewable together.

## What is in a case

| Field | What it answers |
| --- | --- |
| `discovery` | How many moments were proposed, accepted, rejected — and why each rejection happened |
| `preselection` | What the text-only reading made of each candidate, and which ones the build budget went to |
| `construction` | Where boundaries landed, how far they moved, speech pace, and dead air |
| `scoring` | Every component and penalty behind each clip's `overall` |
| `ranking` | The final Shorts in order, with the diversity discount each one paid |
| `diversity` | Pairwise similarity, overlap and timeline proximity between the selected clips |
| `funnel` | Every fixture candidate and the stage it stopped at |

`formatVersion` guards the shape. Bump it in `src/benchmark/types.ts` when the
report changes incompatibly, so an old baseline cannot be compared silently
against a new one.
