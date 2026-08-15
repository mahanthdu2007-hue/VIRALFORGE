/**
 * Opinion / debate.
 *
 * Two people disagreeing quickly, in short turns. Almost every line here is a
 * continuation of the previous speaker's line, which is the failure mode of the
 * genre: a moment lifted out of a debate very often opens on a rebuttal to
 * something the viewer never heard. The fixture also carries a draft whose
 * boundaries fall outside the media entirely.
 */

import type { BenchmarkFixture, FixtureLine } from '../types';

const line = (text: string, speaker: string): FixtureLine => ({ text, speaker });

const A = 'SPEAKER_00';
const B = 'SPEAKER_01';

const lines: readonly FixtureLine[] = [
  /*  0 */ line('I think remote work is the most overrated idea of the last five years.', A),
  /*  1 */ line('That is a strong claim, and I think it is straightforwardly wrong.', B),
  /*  2 */ line('Let me finish, because the claim is narrower than it sounds.', A),
  /*  3 */ line('Remote work is excellent for the individual and terrible for the junior.', A),
  /*  4 */ line('Nobody learns a craft by reading a document at their kitchen table.', A),
  /*  5 */ line('That assumes the office was ever teaching anybody anything at all.', B),
  /*  6 */ line('I learned more from one shared document than from four years of desk neighbours.', B),
  /*  7 */ line('You learned from a document because somebody senior wrote it down for you.', A),
  /*  8 */ line('And they only wrote it down because they were forced to when everyone left.', A),
  /*  9 */ line('So remote work created the artefact that you say remote work cannot produce.', B),
  /* 10 */ line('That is a fair hit, and I will take it.', A),
  /* 11 */ line('But an artefact is not the same thing as a correction.', A),
  /* 12 */ line('Nobody writes a document that says you are holding the saw wrong.', A),
  /* 13 */ line('Then the answer is better feedback, not worse commutes.', B),
  /* 14 */ line('We are arguing about mentorship and calling it geography.', B),
  /* 15 */ line('I would accept that framing if the numbers supported it.', A),
  /* 16 */ line('Our juniors took eleven months to reach the same level in the old system.', A),
  /* 17 */ line('The first fully remote cohort took nineteen months to get there.', A),
  /* 18 */ line('Or your remote onboarding was bad and you measured the wrong thing.', B),
  /* 19 */ line('Possibly, but every company I have asked reports the same shape.', A),
  /* 20 */ line('Every company you have asked has the same hiring pipeline as you do.', B),
  /* 21 */ line('Okay, that is genuinely the best point anyone has made to me on this.', A),
  /* 22 */ line('So the real argument is that we never rebuilt apprenticeship for a new medium.', B),
  /* 23 */ line('Yes, and I would sign that sentence without changing a single word.', A),
  /* 24 */ line('Which means the fight is not remote versus office at all.', B),
  /* 25 */ line('It is whether anybody is still willing to pay for teaching.', A),
  /* 26 */ line('And almost nobody is, because teaching never shows up in a quarterly number.', B),
  /* 27 */ line('That is the most depressing agreement we have ever reached on this show.', A),
  /* 28 */ line('We used to call it apprenticeship and we paid people badly for it.', B),
  /* 29 */ line('Then we called it a graduate scheme and paid them slightly better.', A),
  /* 30 */ line('And now we call it onboarding and hand them a laptop and a wiki.', B),
  /* 31 */ line('The wiki is not the problem here.', A),
  /* 32 */ line('The problem is that nobody sits and reads it with you.', A),
  /* 33 */ line('So what would you actually do, if it were your money?', B),
  /* 34 */ line('I would pay two senior people to teach half the week and ship the other half.', A),
  /* 35 */ line('That is an expensive answer.', B),
  /* 36 */ line('It is cheaper than replacing every junior who leaves after fourteen months.', A),
  /* 37 */ line('Okay. That is a number I am not going to argue with.', B),
];

export const opinionDebateFixture: BenchmarkFixture = {
  id: 'opinion-debate',
  genre: 'opinion-debate',
  title: 'Debate: is remote work overrated?',
  description:
    'Fast two-way disagreement in short turns, where most moments open on a rebuttal to ' +
    'something outside the clip, plus a draft pointing outside the media.',
  wordsPerSecond: 3,
  gapSec: 0.25,
  tailSec: 2,
  language: 'en',
  lines,
  candidates: [
    {
      id: 'deb-claim',
      fromLine: 0,
      toLine: 7,
      topic: 'Remote work and juniors',
      reason: 'A stated position, the objection to it, and the narrower version of the claim.',
      signals: {
        strongOpening: true,
        strongOpinion: true,
        emotionalIntensity: 0.65,
        informationDensity: 0.55,
        standalone: 0.75,
      },
      confidence: 0.8,
      note: 'Opens on the thesis. The most quotable start in the file.',
    },
    {
      id: 'deb-rebuttal',
      fromLine: 9,
      toLine: 16,
      topic: 'Artefacts versus correction',
      reason: 'The strongest exchange of the argument, with a concession in it.',
      signals: {
        strongOpinion: true,
        questionAnswered: true,
        surprise: true,
        emotionalIntensity: 0.6,
        informationDensity: 0.6,
        standalone: 0.4,
      },
      confidence: 0.72,
      note: 'Opens mid-rebuttal, on "And they only wrote it down". Standing alone is the weak point.',
    },
    {
      id: 'deb-numbers',
      fromLine: 18,
      toLine: 25,
      topic: 'What the numbers showed',
      reason: 'Concrete figures, challenged, and then conceded.',
      signals: {
        strongOpinion: true,
        questionAnswered: true,
        payoff: true,
        informationDensity: 0.8,
        standalone: 0.55,
        emotionalIntensity: 0.45,
      },
      confidence: 0.68,
      note: 'The only numeric evidence in the debate.',
    },
    {
      id: 'deb-numbers-shifted',
      fromLine: 19,
      toLine: 26,
      topic: 'What the numbers showed',
      reason: 'The same exchange, one line later.',
      signals: { strongOpinion: true, payoff: true, informationDensity: 0.75, standalone: 0.5 },
      confidence: 0.65,
      note: 'Overlaps deb-numbers almost completely.',
    },
    {
      id: 'deb-agreement',
      fromLine: 28,
      toLine: 37,
      topic: 'Where they agree',
      reason: 'The argument resolving into a shared conclusion.',
      signals: {
        payoff: true,
        strongOpinion: true,
        surprise: true,
        emotionalIntensity: 0.55,
        informationDensity: 0.6,
        standalone: 0.6,
      },
      confidence: 0.62,
      note: 'The clearest landing in the file.',
    },
    {
      id: 'deb-off-media',
      fromLine: 30,
      toLine: 37,
      topic: 'Beyond the recording',
      reason: 'A moment the model placed past the end of the video.',
      signals: { strongOpinion: true, standalone: 0.5 },
      confidence: 0.55,
      startSecOverride: 900,
      endSecOverride: 940,
      note: 'Outside the media. Must be rejected before anything is built.',
    },
  ],
  buildBudget: 4,
  maxSelected: 3,
};
