/**
 * Storytelling.
 *
 * A slow first-person narrative with a long setup, a turn, and a stated lesson,
 * followed by a second smaller story on the same subject. The hard part here is
 * that a story's opening is deliberately *unresolved* — the moment that reads
 * best in isolation is the one that resolves something, and it arrives late.
 * The second story exists to see whether the third slot goes to something new or
 * to another slice of the first.
 */

import type { BenchmarkFixture, FixtureLine } from '../types';

const lines: readonly FixtureLine[] = [
  /*  0 */ { text: 'I got lost in the Cairngorms when I was nineteen years old.' },
  /*  1 */ { text: 'It was March, and I had a map that was eleven years out of date.' },
  /*  2 */ { text: 'The path I wanted had been closed after a landslide the previous autumn.' },
  /*  3 */ { text: 'I did not know that, because the map did not know that.' },
  /*  4 */ { text: 'By four in the afternoon the light was going and I was above the treeline.' },
  /*  5 */ { text: 'I remember the exact moment I understood that I was in trouble.', pauseAfterSec: 1.2 },
  /*  6 */ { text: 'My water bottle was empty and I could hear it rolling around in my pack.' },
  /*  7 */ { text: 'There was no signal, and there had been no signal for two hours.' },
  /*  8 */ { text: 'So I did the only sensible thing anybody had ever taught me.' },
  /*  9 */ { text: 'I stopped walking, sat down on my pack, and ate everything I had left.' },
  /* 10 */ { text: 'That sounds insane, but a cold body cannot think and a hungry body cannot walk.' },
  /* 11 */ { text: 'Twenty minutes later I could think again, and thinking is what saved me.' },
  /* 12 */ { text: 'I remembered that the burn I had crossed ran downhill towards the road.' },
  /* 13 */ { text: 'Water always knows the way out, even when you do not.' },
  /* 14 */ { text: 'I followed it for two hours in the dark and hit a fence line.' },
  /* 15 */ { text: 'The fence took me to a farm track, and the track took me to a road.' },
  /* 16 */ { text: 'A woman driving a livestock trailer stopped without me even lifting a hand.' },
  /* 17 */ { text: 'She did not ask a single question until I had finished her flask of tea.' },
  /* 18 */ { text: 'In the end I learned more that night than in three years of walking clubs.' },
  /* 19 */ { text: 'The mountain did not care how fit I was or how far I had walked before.' },
  /* 20 */ { text: 'Now I carry a paper map, a compass, and an extra day of food.' },
  /* 21 */ { text: 'So I want to tell you what happened the following summer instead.' },
  /* 22 */ { text: 'Because the same thing nearly happened again, and that time it was my fault.' },
  /* 23 */ { text: 'I had the right map, the right kit, and I still went the wrong way.' },
  /* 24 */ { text: 'I trusted a line of footprints in the snow that somebody else had made wrong.' },
  /* 25 */ { text: 'They led me half a mile onto a slope I had no business being on.' },
  /* 26 */ { text: 'The lesson is that other people confidence is not the same as evidence.' },
  /* 27 */ { text: 'I turned around, which is the hardest thing to do when you are nearly there.' },
];

export const storytellingFixture: BenchmarkFixture = {
  id: 'storytelling',
  genre: 'storytelling',
  title: 'Getting lost in the Cairngorms',
  description:
    'Slow first-person narration with a long setup, a resolution that arrives late, and a ' +
    'second story competing for the last slot.',
  wordsPerSecond: 2.3,
  gapSec: 0.45,
  tailSec: 4,
  language: 'en',
  lines,
  candidates: [
    {
      id: 'story-setup',
      fromLine: 0,
      toLine: 7,
      topic: 'Lost above the treeline',
      reason: 'The strongest opening line in the file, and the situation it creates.',
      signals: {
        strongOpening: true,
        story: true,
        surprise: true,
        emotionalIntensity: 0.7,
        informationDensity: 0.6,
        standalone: 0.7,
      },
      confidence: 0.86,
      note: 'Great hook, no resolution. Tests whether a setup can win on its opening alone.',
    },
    {
      id: 'story-turn',
      fromLine: 8,
      toLine: 15,
      topic: 'Stopping to think',
      reason: 'The decision that changed the outcome, and what it led to.',
      signals: {
        story: true,
        payoff: true,
        questionAnswered: true,
        emotionalIntensity: 0.6,
        informationDensity: 0.65,
        standalone: 0.75,
      },
      confidence: 0.64,
      note: 'The moment that actually resolves something.',
    },
    {
      id: 'story-turn-late',
      fromLine: 10,
      toLine: 17,
      topic: 'Stopping to think',
      reason: 'The same turn, entered two lines later.',
      signals: { story: true, payoff: true, emotionalIntensity: 0.55, standalone: 0.6 },
      confidence: 0.61,
      note: 'Overlaps story-turn. Only one of the pair may be selected.',
    },
    {
      id: 'story-lesson',
      fromLine: 16,
      toLine: 22,
      topic: 'What the night taught me',
      reason: 'The stated lesson and the habit that came out of it.',
      signals: {
        story: true,
        payoff: true,
        strongOpinion: true,
        emotionalIntensity: 0.45,
        informationDensity: 0.55,
        standalone: 0.65,
      },
      confidence: 0.6,
      note: 'Lands explicitly. Ends on a line that points forward, which should cost it.',
    },
    {
      id: 'story-second',
      fromLine: 21,
      toLine: 27,
      topic: 'The following summer',
      reason: 'A second, tighter story with its own lesson.',
      signals: {
        story: true,
        payoff: true,
        surprise: true,
        emotionalIntensity: 0.5,
        informationDensity: 0.6,
        standalone: 0.6,
      },
      confidence: 0.58,
      note: 'Distinct material for the third slot.',
    },
    {
      id: 'story-fragment',
      fromLine: 12,
      toLine: 13,
      topic: 'The burn',
      reason: 'A single image from the middle of the story.',
      signals: { emotionalIntensity: 0.4, standalone: 0.2 },
      confidence: 0.4,
      note: 'Around ten seconds of speech. Must be rejected as too short.',
    },
  ],
  buildBudget: 4,
  maxSelected: 3,
};
