/**
 * Fast conversational content.
 *
 * Two friends talking quickly in very short turns — four-plus words a second and
 * a segment every two seconds. This is the fixture that puts pressure on the
 * parts of the pipeline that assume a segment is a sentence: boundary snapping
 * has forty anchors to choose from inside a single Short, and the momentum
 * component sees a pace at the top of the comfortable band.
 *
 * It also contains the genre's characteristic failure: a plug dropped into the
 * middle of a conversation that is otherwise the best moment in the file.
 */

import type { BenchmarkFixture, FixtureLine } from '../types';

const line = (text: string, speaker: string): FixtureLine => ({ text, speaker });

const A = 'SPEAKER_00';
const B = 'SPEAKER_01';

const lines: readonly FixtureLine[] = [
  /*  0 */ line('Okay so you actually did it, you quit on Monday?', A),
  /*  1 */ line('I did, I handed the laptop back at nine in the morning.', B),
  /*  2 */ line('No way. What did they say?', A),
  /*  3 */ line('Nothing for about ten seconds, which felt like an hour.', B),
  /*  4 */ line('Ten seconds of silence is brutal.', A),
  /*  5 */ line('Then my manager said, finally, and shook my hand.', B),
  /*  6 */ line('Wait, finally? He already knew?', A),
  /*  7 */ line('Everyone knew. I had been miserable since about February.', B),
  /*  8 */ line('You hid that very badly, honestly.', A),
  /*  9 */ line('I thought I was being subtle about it!', B),
  /* 10 */ line('You told me you were dreaming about the sprint board.', A),
  /* 11 */ line('Okay that is fair, that is not subtle.', B),
  /* 12 */ line('So what happens now, have you got anything lined up?', A),
  /* 13 */ line('Three months of savings and absolutely no plan.', B),
  /* 14 */ line('That is either very brave or completely unhinged.', A),
  /* 15 */ line('It is both, and I have made my peace with that.', B),
  /* 16 */ line('What are you going to do first?', A),
  /* 17 */ line('Sleep. Then I am going to learn to weld.', B),
  /* 18 */ line('To weld? Where did that come from?', A),
  /* 19 */ line('My grandad welded, and I never asked him one question about it.', B),
  /* 20 */ line('He died in the spring and I keep thinking about that.', B),
  /* 21 */ line('Oh mate. That is actually a really good reason.', A),
  /* 22 */ line('It is the only reason I have, so it will have to do.', B),
  /* 23 */ line('Honestly that beats most business plans I have heard this year.', A),
  /* 24 */ line('It costs four hundred quid for the course and a helmet.', B),
  /* 25 */ line('That is nothing. That is one month of your old commute.', A),
  /* 26 */ line('That is exactly the maths I did on the train home.', B),
  /* 27 */ line('So you worked out that quitting was cheaper than staying.', A),
  /* 28 */ line('I worked out that staying was costing me something I could not buy back.', B),
  /* 29 */ line('Okay, that one is going on a poster.', A),
  /* 30 */ line('Please do not put that on a poster.', B),
  /* 31 */ line('Right, quick thing before we carry on, go and follow the podcast.', A),
  /* 32 */ line('It genuinely helps us more than you would think.', A),
  /* 33 */ line('Anyway, where were we?', B),
  /* 34 */ line('You were being unexpectedly wise about welding.', A),
  /* 35 */ line('The plan is one year, and if it fails I go back to a desk.', B),
  /* 36 */ line('And if it works?', A),
  /* 37 */ line('Then I never look at a sprint board again as long as I live.', B),
  /* 38 */ line('I hope it works. I genuinely do.', A),
  /* 39 */ line('So do I, because the savings run out in June either way.', B),
  /* 40 */ line('One year is not very long to learn a whole trade.', A),
  /* 41 */ line('It is long enough to find out whether I actually like it.', B),
  /* 42 */ line('That is the most reasonable thing you have said all evening.', A),
  /* 43 */ line('Do not worry, it will not last.', B),
];

export const fastConversationalFixture: BenchmarkFixture = {
  id: 'fast-conversational',
  genre: 'fast-conversational',
  title: 'Two friends: quitting without a plan',
  description:
    'Rapid two-way conversation in two-second turns, with a plug dropped into the middle of ' +
    'the best exchange and a four-line moment too short to build.',
  wordsPerSecond: 4.2,
  gapSec: 0.15,
  tailSec: 2,
  language: 'en',
  lines,
  candidates: [
    {
      id: 'fast-quit',
      fromLine: 0,
      toLine: 15,
      topic: 'Quitting on Monday',
      reason: 'A complete exchange: the question, the scene, and the state he is in now.',
      signals: {
        strongOpening: true,
        questionAnswered: true,
        story: true,
        surprise: true,
        emotionalIntensity: 0.7,
        informationDensity: 0.5,
        standalone: 0.75,
      },
      confidence: 0.78,
      note: 'Opens on a direct question. Should rank highly.',
    },
    {
      id: 'fast-weld',
      fromLine: 16,
      toLine: 28,
      topic: 'Learning to weld',
      reason: 'The reason behind the decision, ending on the line that explains all of it.',
      signals: {
        questionAnswered: true,
        story: true,
        payoff: true,
        surprise: true,
        emotionalIntensity: 0.8,
        informationDensity: 0.55,
        standalone: 0.7,
      },
      confidence: 0.7,
      note: 'The emotional centre of the conversation.',
    },
    {
      id: 'fast-weld-wide',
      fromLine: 19,
      toLine: 32,
      topic: 'Learning to weld',
      reason: 'The same exchange, extended past the end of it.',
      signals: { story: true, payoff: true, emotionalIntensity: 0.6, standalone: 0.5 },
      confidence: 0.66,
      note: 'Overlaps fast-weld and runs into the podcast plug.',
    },
    {
      id: 'fast-plug',
      fromLine: 29,
      toLine: 39,
      topic: 'The plan',
      reason: 'Ends on the strongest closing line in the conversation.',
      signals: {
        payoff: true,
        questionAnswered: true,
        emotionalIntensity: 0.6,
        informationDensity: 0.45,
        standalone: 0.55,
      },
      confidence: 0.74,
      note: 'Carries a follow-the-podcast plug in the middle. Should be marked down, not banned.',
    },
    {
      id: 'fast-ending',
      fromLine: 33,
      toLine: 43,
      topic: 'One year',
      reason: 'The clean version of the ending, without the plug.',
      signals: {
        payoff: true,
        questionAnswered: true,
        emotionalIntensity: 0.55,
        informationDensity: 0.4,
        standalone: 0.5,
      },
      confidence: 0.6,
      note: 'Opens on "Anyway", which should cost it on the opening axis.',
    },
    {
      id: 'fast-snippet',
      fromLine: 36,
      toLine: 39,
      topic: 'One year',
      reason: 'Four lines of the closing exchange.',
      signals: { payoff: true, emotionalIntensity: 0.5, standalone: 0.3 },
      confidence: 0.45,
      note: 'Under twenty seconds of speech. Must be rejected as too short.',
    },
  ],
  buildBudget: 4,
  maxSelected: 3,
};
