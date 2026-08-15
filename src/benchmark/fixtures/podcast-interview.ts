/**
 * Podcast / interview.
 *
 * Two voices, a host who opens on channel housekeeping, and a guest who tells
 * one genuinely well-shaped story with a payoff in it. The pressure this puts on
 * the pipeline is *choosing*: the intro is the most confident-looking moment in
 * the file and the worst possible Short, the best moment is discovered twice
 * with different edges, and one draft quotes a line the guest never said.
 */

import type { BenchmarkFixture, FixtureLine } from '../types';

const line = (text: string, speaker: string): FixtureLine => ({ text, speaker });

const HOST = 'SPEAKER_00';
const GUEST = 'SPEAKER_01';

const lines: readonly FixtureLine[] = [
  /*  0 */ line('Welcome back to the show, and before we start, please subscribe and hit that bell icon.', HOST),
  /*  1 */ line('Today my guest has hired around four hundred people over the last decade.', HOST),
  /*  2 */ line('Thanks for having me, it is genuinely good to be here again.', GUEST),
  /*  3 */ line('Let us get straight into it, because I think this is the part people get wrong.', HOST),
  /*  4 */ line('What is the single biggest mistake you see companies make when they hire?', HOST),
  /*  5 */ line('They hire for the job they have today instead of the one they will have next year.', GUEST),
  /*  6 */ line('I watched a company hire nine support agents in a single quarter.', GUEST),
  /*  7 */ line('Six months later they shipped a help centre and half of those roles vanished.', GUEST),
  /*  8 */ line('Nobody had done anything wrong, the work itself simply stopped existing.', GUEST),
  /*  9 */ line('So now I ask one question before every single hire we make.', GUEST),
  /* 10 */ line('If this problem disappeared in a year, what would this person do instead?', GUEST),
  /* 11 */ line('If there is no answer to that, we are hiring a patch, not a person.', GUEST),
  /* 12 */ line('That one question has saved us from about a dozen bad offers.', GUEST),
  /* 13 */ line('That is a brutal thing to ask out loud in a hiring meeting.', HOST),
  /* 14 */ line('It is, and the discomfort is exactly what makes it useful.', GUEST),
  /* 15 */ line('You mentioned earlier that they had already tried the other approach.', HOST),
  /* 16 */ line('Right, and that is why she said what she said about it at the time.', GUEST),
  /* 17 */ line('Anyway, those were the ones he was talking about in the first place.', GUEST),
  /* 18 */ line('Let us talk about interviews, because your process is unusual.', HOST),
  /* 19 */ line('We stopped asking hypothetical questions about three years ago.', GUEST),
  /* 20 */ line('Every candidate now spends two hours on a problem we actually failed at.', GUEST),
  /* 21 */ line('We pay for that time, and they keep whatever they build with us.', GUEST),
  /* 22 */ line('The first time we ran it, our best paper candidate finished last.', GUEST),
  /* 23 */ line('The person we almost rejected on their resume solved it in forty minutes.', GUEST),
  /* 24 */ line('She has since rebuilt the entire billing system on her own.', GUEST),
  /* 25 */ line('So a resume tells you where somebody has been, not what they can do.', GUEST),
  /* 26 */ line('How much did that change your offer rate?', HOST),
  /* 27 */ line('Our acceptance rate went from about half to nearly ninety percent.', GUEST),
  /* 28 */ line('People say yes faster when the interview showed them the actual work.', GUEST),
  /* 29 */ line('That is a huge jump for one process change.', HOST),
  /* 30 */ line('It is, and it cost us nothing but the time we were already spending badly.', GUEST),
  /* 31 */ line('That feels like the right place to stop.', HOST),
  /* 32 */ line('Links to everything we discussed are in the description below, so go and check them out.', HOST),
];

export const podcastInterviewFixture: BenchmarkFixture = {
  id: 'podcast-interview',
  genre: 'podcast-interview',
  title: 'Founder interview: what hiring teaches you',
  description:
    'Two speakers, a housekeeping intro, one strong story found twice, a stretch that leans on ' +
    'material outside itself, and a fabricated hook quote.',
  wordsPerSecond: 2.7,
  gapSec: 0.35,
  tailSec: 3,
  language: 'en',
  lines,
  candidates: [
    {
      id: 'pod-intro',
      fromLine: 0,
      toLine: 5,
      topic: 'Show introduction',
      reason: 'Clean, complete opening exchange that sets up the episode.',
      // The trap: housekeeping reads as a confident, well-formed moment.
      signals: { strongOpening: true, standalone: 0.8, informationDensity: 0.4 },
      confidence: 0.92,
      note: 'Channel housekeeping. Must never win a slot.',
    },
    {
      id: 'pod-hiring-story',
      fromLine: 5,
      toLine: 12,
      topic: 'Hiring for next year',
      reason: 'A concrete failure, the rule drawn from it, and the result of applying it.',
      signals: {
        strongOpening: true,
        story: true,
        payoff: true,
        surprise: true,
        emotionalIntensity: 0.5,
        informationDensity: 0.75,
        standalone: 0.8,
      },
      confidence: 0.71,
      note: 'The best moment in the file. Should rank first.',
    },
    {
      id: 'pod-hiring-story-alt',
      fromLine: 6,
      toLine: 12,
      topic: 'Hiring for next year',
      reason: 'The same anecdote, entered one line later.',
      signals: { story: true, payoff: true, informationDensity: 0.7, standalone: 0.65 },
      confidence: 0.68,
      note: 'Near-duplicate of pod-hiring-story. Exactly one of the two may survive.',
    },
    {
      id: 'pod-callback',
      fromLine: 13,
      toLine: 18,
      topic: 'Follow-up',
      reason: 'A candid exchange about how uncomfortable the question is.',
      signals: { strongOpinion: true, emotionalIntensity: 0.4, standalone: 0.3, informationDensity: 0.3 },
      confidence: 0.55,
      note: 'Leans on pronouns with no referent inside the span.',
    },
    {
      id: 'pod-interview-process',
      fromLine: 19,
      toLine: 25,
      topic: 'Paid work-sample interviews',
      reason: 'A process change, a surprising outcome, and the lesson stated at the end.',
      signals: {
        strongOpening: true,
        story: true,
        payoff: true,
        surprise: true,
        informationDensity: 0.8,
        standalone: 0.75,
        emotionalIntensity: 0.35,
      },
      confidence: 0.66,
      note: 'A second strong moment on a different subject. Should reach the top three.',
    },
    {
      id: 'pod-offer-rate',
      fromLine: 25,
      toLine: 30,
      topic: 'Offer acceptance',
      reason: 'Concrete numbers on what the process change was worth.',
      signals: { questionAnswered: true, informationDensity: 0.7, standalone: 0.55 },
      confidence: 0.6,
      note: 'Adjacent to pod-interview-process; tests the proximity discount.',
    },
    {
      id: 'pod-invented-quote',
      fromLine: 19,
      toLine: 25,
      topic: 'Paid work-sample interviews',
      reason: 'Same span, but the model wrote its own opening line.',
      signals: { strongOpening: true, payoff: true, informationDensity: 0.8, standalone: 0.8 },
      confidence: 0.95,
      hookQuote: 'We threw out the entire interview process overnight.',
      note: 'Never said. Must be rejected by the verbatim guard.',
    },
  ],
  buildBudget: 4,
  maxSelected: 3,
};
