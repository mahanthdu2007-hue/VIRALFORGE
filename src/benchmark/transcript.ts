/**
 * Turning a fixture into something the pipeline will accept.
 *
 * A fixture is written as lines of speech; the pipeline wants a `Transcript`
 * with timed segments and timed words, and a discovery capability that proposes
 * moments inside it. This module is the bridge, and it is the only place in the
 * benchmark that invents a number.
 *
 * Timings are derived, never hand-written: a line's runtime is its word count
 * divided by the fixture's speaking pace, and words are spread evenly across
 * it. That is an approximation of what an ASR provider returns — real word
 * timings are uneven — but it is a *stable* one, which is what a benchmark
 * needs. The pace is a fixture-level property precisely so the momentum
 * component sees a genuinely different clip from a fast conversation than from
 * a slow narration.
 *
 * Fully deterministic: same fixture in, same milliseconds out, no clock and no
 * random source anywhere.
 */

import {
  EMPTY_CLIP_SIGNALS,
  type CandidateClipId,
  type IdFactory,
  type IsoTimestamp,
  type Transcript,
  type TranscriptId,
  type TranscriptSegment,
  type TranscriptSegmentId,
  type TranscriptWord,
  type VideoId,
} from '@/domain';
import type { CandidateClipDraft, ClipDiscoveryCapability, ClipDiscoveryRequest } from '@/ai/types';
import type { BenchmarkFixture, FixtureCandidate } from './types';

/** Fixed ids, so nothing in a report depends on a uuid. */
export const BENCHMARK_VIDEO_ID = '00000000-0000-4000-8000-00000000bench' as VideoId;
export const BENCHMARK_TRANSCRIPT_ID = '00000000-0000-4000-8000-0000000trans' as TranscriptId;

/**
 * Stands in for `nowIso()` on the fixture transcript. No report field copies it
 * — it is pinned so that even an accidental copy could not vary between runs.
 */
const FIXED_CREATED_AT = '2024-01-01T00:00:00.000Z' as IsoTimestamp;

/** A fixture's speech, laid out on a timeline. */
export interface BuiltFixture {
  readonly transcript: Transcript;
  /** Where each line ended up, indexed as written. */
  readonly lineTimes: readonly { readonly startSec: number; readonly endSec: number }[];
  readonly mediaDurationSec: number;
  readonly wordCount: number;
}

/** Lay a fixture's lines end to end and time every word inside them. */
export function buildFixtureTranscript(fixture: BenchmarkFixture): BuiltFixture {
  const lineTimes: { startSec: number; endSec: number }[] = [];
  const segments: TranscriptSegment[] = [];
  let cursor = 0;
  let wordCount = 0;

  fixture.lines.forEach((line, index) => {
    const words = splitWords(line.text);
    if (words.length === 0) {
      throw new Error(`Fixture ${fixture.id} line ${index} has no words.`);
    }

    const startSec = round3(cursor);
    const endSec = round3(startSec + words.length / fixture.wordsPerSecond);

    segments.push({
      id: segmentId(index),
      index,
      startSec,
      endSec,
      text: line.text,
      confidence: 1,
      speaker: line.speaker ?? null,
      words: spreadWords(words, startSec, endSec),
    });

    lineTimes.push({ startSec, endSec });
    wordCount += words.length;
    cursor = endSec + (line.pauseAfterSec ?? fixture.gapSec);
  });

  const lastEnd = lineTimes.at(-1)?.endSec ?? 0;

  return {
    transcript: {
      id: BENCHMARK_TRANSCRIPT_ID,
      videoId: BENCHMARK_VIDEO_ID,
      language: fixture.language,
      source: { provider: 'benchmark-fixture', model: fixture.id },
      segments,
      // Fixed rather than `nowIso()`: a report that changes because a second
      // passed is not a benchmark.
      createdAt: FIXED_CREATED_AT,
    },
    lineTimes,
    mediaDurationSec: round3(lastEnd + fixture.tailSec),
    wordCount,
  };
}

/**
 * The fixture's moments, in the shape discovery returns.
 *
 * Wrapped as a real `ClipDiscoveryCapability` rather than handed to validation
 * directly, so the benchmark enters the pipeline through the same interface a
 * paid provider does — including the request the pipeline builds for it.
 */
export function fixtureDiscovery(fixture: BenchmarkFixture, built: BuiltFixture): ClipDiscoveryCapability {
  return {
    async discoverClips(request: ClipDiscoveryRequest): Promise<readonly CandidateClipDraft[]> {
      return fixture.candidates
        .slice(0, request.maxCandidates)
        .map((candidate) => toDraft(fixture, built, candidate))
        .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
    },
  };
}

/**
 * One fixture candidate as a discovery draft.
 *
 * `hookQuote` defaults to the opening line copied exactly, which is what a
 * well-behaved provider does. A fixture that writes its own is usually testing
 * what happens when a provider does not.
 */
export function toDraft(
  fixture: BenchmarkFixture,
  built: BuiltFixture,
  candidate: FixtureCandidate,
): CandidateClipDraft {
  const from = built.lineTimes[candidate.fromLine];
  const to = built.lineTimes[candidate.toLine];
  if (!from || !to) {
    throw new Error(
      `Fixture ${fixture.id} candidate ${candidate.id} refers to lines ` +
        `${candidate.fromLine}..${candidate.toLine}, outside its ${built.lineTimes.length} lines.`,
    );
  }

  const openingLine = fixture.lines[candidate.fromLine]?.text ?? '';

  return {
    startSec: candidate.startSecOverride ?? from.startSec,
    endSec: candidate.endSecOverride ?? to.endSec,
    hookQuote: candidate.hookQuote === undefined ? openingLine : candidate.hookQuote,
    topic: candidate.topic,
    reason: candidate.reason,
    signals: { ...EMPTY_CLIP_SIGNALS, ...candidate.signals },
    confidence: candidate.confidence === null ? undefined : (candidate.confidence ?? 0.5),
  };
}

/**
 * An id factory that hands out the fixture's own labels, in order.
 *
 * Candidate ids reach the tie-breaks in preselection and ranking, so a uuid
 * would make the benchmark's ordering unreproducible in exactly the cases where
 * ordering is most worth pinning down.
 */
export function labelFactory(labels: readonly string[]): IdFactory {
  let next = 0;
  return () => {
    const label = labels[next];
    next += 1;
    if (label === undefined) throw new Error('Benchmark id factory ran out of labels.');
    return label as CandidateClipId;
  };
}

/* -------------------------------------------------------------------------- */

/** Words spread evenly across the line, with the last landing on its end. */
function spreadWords(words: readonly string[], startSec: number, endSec: number): TranscriptWord[] {
  const step = (endSec - startSec) / words.length;

  return words.map((text, index) => ({
    text,
    startSec: round3(startSec + index * step),
    endSec: index === words.length - 1 ? endSec : round3(startSec + (index + 1) * step),
  }));
}

const splitWords = (text: string): string[] => text.split(/\s+/u).filter(Boolean);

/** Zero-padded so id order matches timeline order under a string comparison. */
const segmentId = (index: number): TranscriptSegmentId =>
  `seg-${String(index).padStart(3, '0')}` as TranscriptSegmentId;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
