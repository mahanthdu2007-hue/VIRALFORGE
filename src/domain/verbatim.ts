/**
 * Verbatim guard — the enforcement point for "never rewrite the speaker".
 *
 * Any quote attached to a candidate or a clip must be traceable to the
 * transcript. This is a **deterministic string check**, never a model judgement:
 * an LLM asked "is this quote faithful?" is exactly the component we do not
 * trust here.
 *
 * Normalisation is limited to differences that cannot change what was said —
 * unicode form, typographic punctuation, case, whitespace. Words are never
 * added, removed, reordered or stemmed.
 */

/** Why a quote failed verification. A passing check reports `null`. */
export type QuoteRejectionCode =
  | 'empty_quote'
  | 'empty_source'
  | 'not_found_in_source'
  | 'quote_longer_than_source';

export interface QuoteVerification {
  readonly ok: boolean;
  readonly code: QuoteRejectionCode | null;
  readonly reason: string | null;
}

/** Straight and typographic apostrophes, and the prime often emitted for one. */
const APOSTROPHES = /['‘’‛′]/gu;

/** Any run of characters that is neither a letter nor a digit. */
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

/**
 * Reduce text to a comparable form.
 *
 * Order matters: unicode normalisation first (so composed and decomposed
 * accents match), then case folding, then apostrophe removal, then every
 * remaining non-alphanumeric run collapses to a single space.
 *
 * Punctuation is dropped entirely rather than mapped to a canonical form,
 * because ASR punctuation is a model guess: "it works, really" and "it works
 * really" are the same speech. Apostrophes are deleted rather than turned into
 * gaps so "don't" and "dont" compare equal instead of becoming "don t".
 *
 * This is *only* a comparison key. The stored transcript, and any text we later
 * display or burn in, is never passed through it.
 */
export function normaliseForComparison(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(NON_ALPHANUMERIC, ' ')
    .trim();
}

/**
 * Is `quote` present in `source` after safe normalisation?
 *
 * Word-boundary aware: a quote must align to whole words, so "he ran" does not
 * match "the rant".
 */
export function isQuoteTraceable(quote: string, source: string): boolean {
  return verifyQuote(quote, source).ok;
}

/**
 * Full verification with a machine-readable reason, so rejections can be logged
 * and counted rather than silently dropped.
 *
 * @param quote  candidate-supplied text claiming to come from the speaker
 * @param source verbatim transcript text the quote must occur in
 */
export function verifyQuote(quote: string, source: string): QuoteVerification {
  const needle = normaliseForComparison(quote);
  if (needle.length === 0) {
    return { ok: false, code: 'empty_quote', reason: 'Quote is empty after normalisation.' };
  }

  const haystack = normaliseForComparison(source);
  if (haystack.length === 0) {
    return { ok: false, code: 'empty_source', reason: 'Source text is empty after normalisation.' };
  }

  if (needle.length > haystack.length) {
    return {
      ok: false,
      code: 'quote_longer_than_source',
      reason: 'Quote is longer than the source text it claims to come from.',
    };
  }

  // Both sides are single-space-joined word sequences, so padding both makes a
  // plain `includes` boundary-safe without building a regex from untrusted text.
  if (!` ${haystack} `.includes(` ${needle} `)) {
    return {
      ok: false,
      code: 'not_found_in_source',
      reason: 'Quote does not occur in the transcript; it appears altered or invented.',
    };
  }

  return { ok: true, code: null, reason: null };
}
