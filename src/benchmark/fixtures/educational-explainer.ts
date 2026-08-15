/**
 * Educational / explainer.
 *
 * One voice, numbers throughout, and an argument that only pays off if the
 * viewer stays to the end. Two things are under test here: whether a mid-video
 * sponsor read can be kept out of the top three, and whether the scorer can tell
 * a moment that *states* a result from one that merely sets it up — the same
 * sentences appear in both.
 */

import type { BenchmarkFixture, FixtureLine } from '../types';

const lines: readonly FixtureLine[] = [
  /*  0 */ { text: 'Compound interest gets explained badly, so let us fix that in the next few minutes.' },
  /*  1 */ { text: 'Imagine you put one thousand pounds into an account paying five percent a year.' },
  /*  2 */ { text: 'After the first year you have one thousand and fifty pounds.' },
  /*  3 */ { text: 'Most people then assume year two adds another fifty pounds on top.' },
  /*  4 */ { text: 'It does not, because year two pays interest on the fifty as well.' },
  /*  5 */ { text: 'So you earn fifty two pounds and fifty pence instead.' },
  /*  6 */ { text: 'That extra pound and fifty pence is the whole idea in one number.' },
  /*  7 */ { text: 'It looks trivial, and for the first few years it genuinely is trivial.' },
  /*  8 */ { text: 'The interesting part only shows up when you leave it alone for decades.' },
  /*  9 */ { text: 'After ten years the account holds about one thousand six hundred pounds.' },
  /* 10 */ { text: 'After thirty years it holds four thousand three hundred pounds.' },
  /* 11 */ { text: 'You never added a penny, and the money more than quadrupled.' },
  /* 12 */ { text: 'Here is the part that surprises almost everybody.' },
  /* 13 */ { text: 'Roughly half of that total arrived in the final ten years.' },
  /* 14 */ { text: 'Growth is not spread evenly across the time you spend waiting.' },
  /* 15 */ { text: 'The last decade always does more work than the first two combined.' },
  /* 16 */ { text: 'So starting early matters far more than the interest rate you chase.' },
  /* 17 */ { text: 'A person who starts at twenty five beats a person who starts at thirty five.' },
  /* 18 */ { text: 'That holds even when the second person saves twice as much every month.' },
  /* 19 */ { text: 'Quick reminder to like this video if the numbers are helping you.' },
  /* 20 */ { text: 'And there is a free calculator linked in the description below.' },
  /* 21 */ { text: 'Now let us talk about what breaks this whole model.' },
  /* 22 */ { text: 'Inflation eats about two to three percent of that return every single year.' },
  /* 23 */ { text: 'So a five percent account is really growing at two or three percent.' },
  /* 24 */ { text: 'Fees do the same thing, quietly, and they compound against you.' },
  /* 25 */ { text: 'A one percent annual fee removes roughly a quarter of a lifetime return.' },
  /* 26 */ { text: 'That is the same maths running in the opposite direction.' },
  /* 27 */ { text: 'So the two rules are simple: start early, and keep the fees small.' },
  /* 28 */ { text: 'Everything else in personal finance is decoration on top of those two.' },
];

export const educationalExplainerFixture: BenchmarkFixture = {
  id: 'educational-explainer',
  genre: 'educational-explainer',
  title: 'Explainer: what compound interest actually does',
  description:
    'Single narrator, dense numeric detail, a sponsor read in the middle, and a moment that is ' +
    'a setup rather than a payoff despite reading well.',
  wordsPerSecond: 2.5,
  gapSec: 0.3,
  tailSec: 2.5,
  language: 'en',
  lines,
  candidates: [
    {
      id: 'edu-mechanism',
      fromLine: 0,
      toLine: 6,
      topic: 'How compounding works',
      reason: 'Opens on a promise and closes on the single number that carries the idea.',
      signals: {
        strongOpening: true,
        questionAnswered: true,
        payoff: true,
        informationDensity: 0.85,
        standalone: 0.8,
        emotionalIntensity: 0.25,
      },
      confidence: 0.74,
      note: 'Complete explanation with a landing. Should rank near the top.',
    },
    {
      id: 'edu-setup',
      fromLine: 7,
      toLine: 13,
      topic: 'Where the growth hides',
      reason: 'Builds towards the surprise but stops on the reveal itself.',
      signals: { surprise: true, informationDensity: 0.8, standalone: 0.6 },
      confidence: 0.7,
      note: 'A setup, not a landing. Should score below edu-lesson.',
    },
    {
      id: 'edu-lesson',
      fromLine: 12,
      toLine: 18,
      topic: 'Start early',
      reason: 'States the surprising result and then the rule that follows from it.',
      signals: {
        strongOpening: true,
        surprise: true,
        payoff: true,
        informationDensity: 0.8,
        standalone: 0.75,
        emotionalIntensity: 0.3,
      },
      confidence: 0.69,
      note: 'Overlaps edu-setup and says the same thing better. One of the two, at most.',
    },
    {
      id: 'edu-sponsor',
      fromLine: 19,
      toLine: 23,
      topic: 'Housekeeping and inflation',
      reason: 'Well-formed sentences either side of the call to action.',
      signals: { strongOpening: true, standalone: 0.7, informationDensity: 0.5 },
      confidence: 0.88,
      note: 'Opens on a call to action. Must not reach the top three.',
    },
    {
      id: 'edu-fees',
      fromLine: 21,
      toLine: 27,
      topic: 'What breaks compounding',
      reason: 'The counter-argument, with figures, resolved into two rules.',
      signals: {
        questionAnswered: true,
        payoff: true,
        strongOpinion: true,
        informationDensity: 0.85,
        standalone: 0.7,
      },
      confidence: 0.63,
      note: 'Distinct subject, clean landing. Expected in the top three.',
    },
    {
      id: 'edu-whole-video',
      fromLine: 0,
      toLine: 17,
      topic: 'The whole explanation',
      reason: 'The entire argument in one span.',
      signals: { story: true, payoff: true, informationDensity: 0.9, standalone: 0.9 },
      confidence: 0.5,
      note: 'Far past the 60s discovery window. Must be rejected as too long.',
    },
  ],
  buildBudget: 4,
  maxSelected: 3,
};
