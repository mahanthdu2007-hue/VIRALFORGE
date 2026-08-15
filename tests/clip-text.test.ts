import { describe, expect, it } from 'vitest';
import {
  analyseText,
  clamp01,
  contentWords,
  endsSentence,
  measurePayoff,
  repeatedTrigramRatio,
  splitSentences,
  textSimilarity,
  tokenise,
} from '@/clips/text';

describe('endsSentence', () => {
  it('recognises sentence-final punctuation', () => {
    expect(endsSentence('Hello there.')).toBe(true);
    expect(endsSentence('Really?!')).toBe(true);
    expect(endsSentence('Wait…')).toBe(true);
  });

  it('recognises a closing quote after punctuation', () => {
    expect(endsSentence('She said "stop."')).toBe(true);
  });

  it('rejects text with no terminal punctuation', () => {
    expect(endsSentence('and then we')).toBe(false);
  });
});

describe('splitSentences', () => {
  it('splits on sentence-final punctuation', () => {
    expect(splitSentences('Hello there. How are you? Fine!')).toEqual([
      'Hello there.',
      'How are you?',
      'Fine!',
    ]);
  });

  it('returns the whole text as one sentence when there is no punctuation', () => {
    expect(splitSentences('and then we just kept going')).toEqual(['and then we just kept going']);
  });

  it('returns an empty array for blank input', () => {
    expect(splitSentences('   ')).toEqual([]);
  });
});

describe('tokenise', () => {
  it('lowercases and strips punctuation', () => {
    expect(tokenise('Hello, World!')).toEqual(['hello', 'world']);
  });

  it('keeps apostrophes inside a word rather than splitting on them', () => {
    expect(tokenise("don't stop")).toEqual(['dont', 'stop']);
  });

  it('returns an empty array for punctuation-only input', () => {
    expect(tokenise('...')).toEqual([]);
  });
});

describe('repeatedTrigramRatio', () => {
  it('returns 0 for fewer than 6 tokens', () => {
    expect(repeatedTrigramRatio(['a', 'b', 'c', 'd'])).toBe(0);
  });

  it('returns 0 when no trigram repeats', () => {
    const tokens = tokenise('the quick brown fox jumps over the lazy dog');
    expect(repeatedTrigramRatio(tokens)).toBe(0);
  });

  it('detects an exactly repeated three-word run', () => {
    const tokens = tokenise('it was amazing it was amazing honestly');
    expect(repeatedTrigramRatio(tokens)).toBeGreaterThan(0);
  });
});

describe('analyseText', () => {
  it('measures filler ratio from filler words and phrases', () => {
    const features = analyseText('um so you know I basically think it worked');
    expect(features.fillerRatio).toBeGreaterThan(0);
  });

  it('returns zero filler ratio for clean text', () => {
    const features = analyseText('We shipped the feature on Friday and it worked well.');
    expect(features.fillerRatio).toBe(0);
  });

  it('flags an opener as continuation when it starts with a conjunction', () => {
    const features = analyseText('And that is when everything changed.');
    expect(features.opensOnContinuation).toBe(true);
  });

  it('does not flag a normal opener as continuation', () => {
    const features = analyseText('This is when everything changed.');
    expect(features.opensOnContinuation).toBe(false);
  });

  it('flags hook words and question openers', () => {
    expect(analyseText('Why does nobody talk about this?').opensOnHookWord).toBe(true);
    expect(analyseText('Is this thing even working?').opensOnHookWord).toBe(true);
  });

  it('counts question and exclamation marks', () => {
    const features = analyseText('Really? Really?! Yes!');
    expect(features.questionCount).toBe(2);
    expect(features.exclamationCount).toBe(2);
  });

  it('raises context dependency for a pronoun opener with no antecedent', () => {
    const withPronoun = analyseText('It was the best decision we ever made.');
    const withoutPronoun = analyseText('That decision was the best we ever made.');
    expect(withPronoun.contextDependency).toBeGreaterThan(0);
    expect(withoutPronoun.contextDependency).toBeGreaterThanOrEqual(0);
  });

  it('raises context dependency for an explicit backreference phrase', () => {
    const features = analyseText('As I mentioned earlier, this changes everything.');
    expect(features.contextDependency).toBeGreaterThan(0);
  });

  it('handles empty text without throwing', () => {
    const features = analyseText('');
    expect(features.wordCount).toBe(0);
    expect(features.fillerRatio).toBe(0);
    expect(features.lexicalVariety).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Payoff                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Endings, all on the same setup so only the last line is under test.
 *
 * The point of the measurement is that a clip can land without ever saying "the
 * lesson is", so most of these carry no payoff phrase at all.
 */
const SETUP = [
  'Every time somebody quit we opened the same job again.',
  'We wrote the same description and interviewed for the same skills.',
  'Six months later the work itself had moved on without us.',
].join(' ');

const endingWith = (last: string): string => `${SETUP} ${last}`;
const strengthOf = (text: string): number => analyseText(text).payoffStrength;

describe('measurePayoff', () => {
  it('credits an explicit payoff phrase in the closing lines', () => {
    expect(strengthOf(endingWith('The lesson is that we were hiring for last year.'))).toBeGreaterThan(0.8);
  });

  it('credits a natural resolution that never announces itself', () => {
    // The two endings the phrase list scored at nothing.
    expect(strengthOf(endingWith('We are hiring a patch, not a person.'))).toBeGreaterThan(0.35);
    expect(
      strengthOf(endingWith('Staying was costing me something I could not buy back.')),
    ).toBeGreaterThan(0.35);
  });

  it('credits a contrastive ending', () => {
    const contrast = strengthOf(endingWith('A resume tells you where somebody has been, not what they can do.'));
    const flat = strengthOf(endingWith('A resume tells you where somebody has been.'));
    expect(contrast).toBeGreaterThan(flat);
  });

  it('credits an ending that answers a question the clip asked', () => {
    const asked = strengthOf(
      'What is the biggest mistake companies make when they hire? Everybody has a theory about it. ' +
        'They hire for the job they have today.',
    );
    const unasked = strengthOf(
      'Companies make one mistake when they hire. Everybody has a theory about it. ' +
        'They hire for the job they have today.',
    );
    expect(asked).toBeGreaterThan(unasked);
  });

  it('credits a causal or result ending', () => {
    const causal = strengthOf(endingWith('The dough never doubled because the room was too cold.'));
    const plain = strengthOf(endingWith('The dough sat in the cold room overnight.'));
    expect(causal).toBeGreaterThan(plain);
  });

  it('gives a weak generic ending almost nothing', () => {
    expect(strengthOf(endingWith('It is what it is.'))).toBeLessThan(0.1);
    expect(strengthOf(endingWith('So that was that, really.'))).toBeLessThan(0.25);
  });

  it('gives an unfinished ending almost nothing, whatever it was about to say', () => {
    expect(strengthOf(endingWith('And the lesson we took from all of it was that'))).toBeLessThan(0.2);
    expect(strengthOf(endingWith('So we ended up going back to the'))).toBeLessThan(0.2);
  });

  it('gives a call-to-action ending almost nothing', () => {
    const cta = strengthOf(
      `${SETUP} The lesson is that we were hiring for last year. Link in the description if you want the notes.`,
    );
    expect(cta).toBeLessThan(0.15);
  });

  it('does not credit a payoff phrase that only appears in the middle', () => {
    const lands = strengthOf(`${SETUP} The lesson is that we were hiring for last year.`);
    const middle = strengthOf(
      `The lesson is that we were hiring for last year. ${SETUP} We tried it again the next quarter.`,
    );

    expect(middle).toBeLessThan(lands);
    expect(middle).toBeLessThan(0.4);
  });

  it('does not credit an ending that only restates the setup', () => {
    const fresh = strengthOf(endingWith('We were paying for a problem that had already solved itself.'));
    const restated = strengthOf(endingWith('We opened the same job and interviewed for the same skills.'));
    expect(restated).toBeLessThan(fresh);
  });

  it('does not credit a question the clip never answers', () => {
    const answered = strengthOf(endingWith('So we stopped hiring for the job we already had.'));
    const dangling = strengthOf(endingWith('So what are you actually hiring for?'));
    expect(dangling).toBeLessThan(0.25);
    expect(dangling).toBeLessThan(answered);
  });

  it('stays bounded and deterministic', () => {
    const samples = [
      '',
      '   ',
      'One line and nothing else.',
      endingWith('We are hiring a patch, not a person.'),
      endingWith('And the lesson we took from all of it was that'),
    ];

    for (const text of samples) {
      const first = analyseText(text).payoffStrength;
      const second = analyseText(text).payoffStrength;
      expect(second).toBe(first);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThanOrEqual(1);
    }

    expect(measurePayoff([])).toBe(0);
    expect(measurePayoff(splitSentences(endingWith('The lesson is that we were hiring for last year.')))).toBe(
      strengthOf(endingWith('The lesson is that we were hiring for last year.')),
    );
  });
});

describe('clamp01', () => {
  it('clamps to the 0..1 range', () => {
    expect(clamp01(-5)).toBe(0);
    expect(clamp01(5)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });

  it('treats non-finite input as 0', () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
  });
});

describe('contentWords / textSimilarity', () => {
  it('excludes stop words and short tokens', () => {
    const words = contentWords('The cat sat on the mat and it was fine');
    expect(words.has('the')).toBe(false);
    expect(words.has('cat')).toBe(true);
  });

  it('scores identical text as fully similar', () => {
    expect(textSimilarity('We shipped the feature on Friday', 'We shipped the feature on Friday')).toBeCloseTo(1);
  });

  it('scores unrelated text as dissimilar', () => {
    const score = textSimilarity(
      'We shipped the feature on Friday afternoon',
      'The weather in Iceland was surprisingly warm',
    );
    expect(score).toBeLessThan(0.3);
  });

  it('returns 0 when either side has no content words', () => {
    expect(textSimilarity('the a an', 'We shipped the feature')).toBe(0);
    expect(textSimilarity('', '')).toBe(0);
  });
});
