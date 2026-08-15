import { describe, expect, it } from 'vitest';
import { isQuoteTraceable, normaliseForComparison, verifyQuote } from '@/domain';

const SOURCE =
  "I thought it would take a year. It took us three weeks — and honestly, that surprised everyone on the team. Don't ask me how.";

describe('normaliseForComparison', () => {
  it('folds case, punctuation and whitespace', () => {
    expect(normaliseForComparison('  Hello,   WORLD! ')).toBe('hello world');
  });

  it('deletes apostrophes rather than splitting the word', () => {
    expect(normaliseForComparison("don't")).toBe('dont');
    expect(normaliseForComparison('don’t')).toBe('dont');
  });

  it('treats dashes and ellipses as gaps', () => {
    expect(normaliseForComparison('three weeks — and honestly')).toBe('three weeks and honestly');
    expect(normaliseForComparison('wait… what')).toBe('wait what');
  });

  it('normalises unicode composition so accents compare equal', () => {
    expect(normaliseForComparison('café')).toBe(normaliseForComparison('café'));
  });

  it('keeps digits', () => {
    expect(normaliseForComparison('It took 3 weeks.')).toBe('it took 3 weeks');
  });

  it('collapses to empty for punctuation-only input', () => {
    expect(normaliseForComparison('  ---  ')).toBe('');
  });
});

describe('verifyQuote', () => {
  it('accepts an exact match', () => {
    expect(verifyQuote('It took us three weeks', SOURCE)).toMatchObject({ ok: true, code: null });
  });

  it('accepts differences in punctuation', () => {
    expect(verifyQuote('It took us three weeks!!!', SOURCE).ok).toBe(true);
    expect(verifyQuote('I thought it would take a year', SOURCE).ok).toBe(true);
  });

  it('accepts differences in whitespace', () => {
    expect(verifyQuote('  It   took\nus\tthree   weeks  ', SOURCE).ok).toBe(true);
  });

  it('accepts differences in case', () => {
    expect(verifyQuote('IT TOOK US THREE WEEKS', SOURCE).ok).toBe(true);
  });

  it('accepts a typographic apostrophe where the source has a straight one', () => {
    expect(verifyQuote('Don’t ask me how', SOURCE).ok).toBe(true);
  });

  it('accepts the whole source as its own quote', () => {
    expect(verifyQuote(SOURCE, SOURCE).ok).toBe(true);
  });

  it('rejects a fabricated quote', () => {
    const result = verifyQuote('It took us three days', SOURCE);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not_found_in_source');
  });

  it('rejects a quote with an inserted word', () => {
    expect(verifyQuote('It took us just three weeks', SOURCE).ok).toBe(false);
  });

  it('rejects a quote with a dropped word', () => {
    expect(verifyQuote('It took three weeks', SOURCE).ok).toBe(false);
  });

  it('rejects reordered words', () => {
    expect(verifyQuote('three weeks took us it', SOURCE).ok).toBe(false);
  });

  it('rejects a partially valid quote that runs past the source', () => {
    const result = verifyQuote('that surprised everyone on the team and the investors', SOURCE);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not_found_in_source');
  });

  it('rejects a quote longer than the source', () => {
    expect(verifyQuote(`${SOURCE} ${SOURCE}`, SOURCE)).toMatchObject({
      ok: false,
      code: 'quote_longer_than_source',
    });
  });

  it('rejects an empty or punctuation-only quote', () => {
    expect(verifyQuote('', SOURCE).code).toBe('empty_quote');
    expect(verifyQuote('   ...  ', SOURCE).code).toBe('empty_quote');
  });

  it('rejects any quote against an empty source', () => {
    expect(verifyQuote('anything', '').code).toBe('empty_source');
  });

  it('always explains a rejection', () => {
    const result = verifyQuote('never said this', SOURCE);
    expect(result.reason).toBeTruthy();
  });
});

describe('isQuoteTraceable word boundaries', () => {
  it('does not match across a word boundary', () => {
    // "he ran" must not be found inside "the rant".
    expect(isQuoteTraceable('he ran', 'I ended the rant early.')).toBe(false);
  });

  it('does not match a prefix of a longer word', () => {
    expect(isQuoteTraceable('cat', 'the catalogue is long')).toBe(false);
  });

  it('matches a phrase at the very start and very end', () => {
    expect(isQuoteTraceable('I thought', SOURCE)).toBe(true);
    expect(isQuoteTraceable('ask me how', SOURCE)).toBe(true);
  });
});
