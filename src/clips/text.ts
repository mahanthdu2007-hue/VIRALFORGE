/**
 * Text features read off transcript speech.
 *
 * Everything here is a **measurement**, not a judgement: it counts what is in
 * the words and returns numbers. No function in this file ever produces text
 * that could be mistaken for speech, and none of them modify the transcript —
 * the strings they return are always slices of what was said.
 *
 * The lexicons are deliberately small and English-only. They are a heuristic
 * floor under the model's semantic reading, not a replacement for it, and a
 * missing word costs a fraction of a point rather than breaking anything.
 */

/** Sentence-ending punctuation, optionally followed by a closing quote. */
const SENTENCE_END = /[.!?…]["'”’)\]]*$/u;

/** Splits on sentence-final punctuation, keeping the punctuation. */
const SENTENCE_SPLIT = /(?<=[.!?…]["'”’)\]]*)\s+/u;

export const endsSentence = (text: string): boolean => SENTENCE_END.test(text.trim());

/**
 * Split verbatim text into sentences.
 *
 * ASR punctuation is a model guess, so a "sentence" here is a best-effort
 * reading unit. Text with no punctuation at all comes back as one sentence
 * rather than being chopped arbitrarily.
 */
export function splitSentences(text: string): string[] {
  return text
    .trim()
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Lowercased alphanumeric word tokens. Apostrophes are kept inside a word. */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/['’]/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/* -------------------------------------------------------------------------- */
/* Lexicons                                                                   */
/* -------------------------------------------------------------------------- */

/** Padding wherever it appears — there is no reading of "um" that carries meaning. */
const FILLER_WORDS = new Set([
  'um',
  'uh',
  'erm',
  'ah',
  'hmm',
  'mm',
  'mhm',
  'basically',
  'literally',
  'actually',
  'anyway',
  'whatever',
]);

/**
 * Words that are padding only in *discourse position* — opening a clause.
 *
 * "Right, so we shipped it" is padding; "we picked the right approach" is the
 * speaker's actual point. Counting the second as filler penalised clean clips
 * for using ordinary English, so these are matched with their left context.
 */
const DISCOURSE_MARKERS = ['yeah', 'okay', 'ok', 'right', 'well', 'like', 'sure', 'alright'];

/** A discourse marker preceded by nothing, or by clause-ending punctuation. */
const DISCOURSE_MARKER_RE = new RegExp(
  String.raw`(?:^|[.!?…,;:—–-])\s*(?:${DISCOURSE_MARKERS.join('|')})\b`,
  'giu',
);

/** Multi-word padding. Counted by occurrence, each worth its own word count. */
const FILLER_PHRASES = [
  'you know',
  'i mean',
  'sort of',
  'kind of',
  'or something',
  'and stuff',
  'if that makes sense',
  'like i said',
];

/** Openers that only make sense as a continuation of something earlier. */
const CONTINUATION_OPENERS = new Set([
  'and',
  'but',
  'so',
  'because',
  'which',
  'also',
  'then',
  'anyway',
  'plus',
  'however',
  'therefore',
  'though',
]);

/** Words pointing at a referent the clip does not contain. */
const DEICTIC_WORDS = new Set(['he', 'she', 'they', 'him', 'her', 'them', 'it', 'this', 'that', 'those', 'these', 'such']);

/** Phrases that explicitly refer to material outside the clip. */
const BACKREFERENCE_PHRASES = [
  'as i said',
  'as i mentioned',
  'like i mentioned',
  'as we discussed',
  'going back to',
  'earlier i',
  'as you saw',
  'the one i showed',
  'that other thing',
  'back to what',
];

const CURIOSITY_WORDS = new Set([
  'why',
  'how',
  'secret',
  'mistake',
  'nobody',
  'everyone',
  'never',
  'always',
  'until',
  'suddenly',
  'realised',
  'realized',
  'discovered',
  'wrong',
  'truth',
  'reason',
]);

const EMOTION_WORDS = new Set([
  'love',
  'hate',
  'terrified',
  'scared',
  'afraid',
  'furious',
  'angry',
  'amazing',
  'incredible',
  'unbelievable',
  'shocked',
  'stunned',
  'devastated',
  'heartbreaking',
  'painful',
  'brutal',
  'insane',
  'crazy',
  'exhausted',
  'proud',
  'grateful',
  'desperate',
  'obsessed',
  'humiliating',
  'joy',
  'fear',
]);

const PAYOFF_PHRASES = [
  'turns out',
  'the result',
  'the lesson',
  'thats why',
  'that is why',
  'in the end',
  'what happened was',
  'the answer is',
  'so we',
  'and it worked',
  'the point is',
];

/**
 * Phrases that close a thought rather than open one, read alongside
 * `PAYOFF_PHRASES` and only in the clip's final sentences — where they mean
 * the clip actually lands somewhere. Kept disjoint from that list so a single
 * phrase cannot be counted twice.
 */
const RESOLUTION_PHRASES = [
  'the takeaway',
  'which is why',
  'we ended up',
  'i ended up',
  'ever since',
  'and that changed',
  'from then on',
  'that is when',
  'thats when',
  'so now',
];

/**
 * Markers that a thought has been carried to its end.
 *
 * Disjoint from `PAYOFF_PHRASES` and `RESOLUTION_PHRASES` so the three read as
 * three independent signals rather than the same phrase counted three times.
 */
const CONCLUSION_MARKERS = [
  'finally',
  'eventually',
  'ultimately',
  'at the end of the day',
  'since then',
  'to this day',
  'from that day',
  'never again',
  'once and for all',
  'for good',
];

/** Language that states a consequence: the ending follows from what came before. */
const CAUSAL_MARKERS = [
  'because',
  'which meant',
  'which means',
  'as a result',
  'so that',
  'led to',
  'meant that',
  'which left',
  'made me',
  'made us',
  'forced me',
  'forced us',
  'that is how',
  'thats how',
];

/**
 * Constructions that land by setting the ending against what the clip set up.
 *
 * "We are hiring a patch, not a person" carries no payoff *phrase* at all; the
 * whole of its resolution is in the contrast, which is why a fixed phrase list
 * never scored it.
 */
const CONTRAST_MARKERS = [
  'not a',
  'not the',
  'not just',
  'not about',
  'not because',
  'not what',
  'not who',
  'rather than',
  'instead of',
  'no longer',
  'was not',
  'is not',
  'wasnt',
  'isnt',
  'could not',
  'couldnt',
  'cannot',
  'cant',
  'would not',
  'wouldnt',
];

/** Words naming a change of state, a cost paid, or a thing settled. */
const RESOLUTION_WORDS = new Set([
  'changed',
  'changes',
  'stopped',
  'ended',
  'learned',
  'learnt',
  'realised',
  'realized',
  'fixed',
  'solved',
  'worked',
  'quit',
  'left',
  'saved',
  'cost',
  'costing',
  'lost',
  'won',
  'gone',
  'beats',
  'matters',
  'difference',
  'lesson',
  'answer',
  'result',
  'truth',
  'reason',
  'worth',
  'forever',
]);

/** Hedges. A closing line that qualifies itself is not a decisive assertion. */
const HEDGE_PHRASES = [
  'maybe',
  'probably',
  'perhaps',
  'i think',
  'i guess',
  'i suppose',
  'i dont know',
  'not sure',
  'who knows',
  'might be',
  'sort of',
  'kind of',
  'or something',
];

/**
 * Channel housekeeping: greetings, sign-offs, calls to action, sponsor reads.
 *
 * Verbatim speech, but not *content* — a Short that opens on "hey guys welcome
 * back" spends its first seconds saying nothing. Written without apostrophes
 * because they are matched against tokenised text, which strips them.
 */
const BOILERPLATE_PHRASES = [
  'hey guys',
  'hi guys',
  'hey everyone',
  'hi everyone',
  'hello everyone',
  'hey there',
  'whats up guys',
  'what is up guys',
  'welcome back',
  'welcome to the channel',
  'welcome to my channel',
  'thanks for watching',
  'thank you for watching',
  'dont forget to subscribe',
  'do not forget to subscribe',
  'hit subscribe',
  'hit the subscribe',
  'subscribe to the channel',
  'smash that like',
  'hit the like button',
  'leave a comment',
  'comment below',
  'link in the description',
  'link in the bio',
  'link below',
  'in todays video',
  'in this video',
  'before we get started',
  'before we begin',
  'lets get started',
  'lets get into it',
  'lets dive in',
  'lets jump in',
  'see you in the next one',
  'see you next time',
  'todays sponsor',
  'sponsored by',
  'check out my',
  'follow me on',
  'good morning everyone',
  'good evening everyone',
];

/**
 * Advertising, as it is actually spoken.
 *
 * Built from real sponsor segments a live run selected as Shorts, which is why
 * it does not look like a list of the word "sponsor". The reads that got through
 * never said "sponsored by" — they said *"Thanks to our friends at Motrin"*, and
 * *"our brand new beefsticks… it tastes great… if you wanna try them, it's a bit
 * about these retailers"*. A creator reading an ad talks about the product the
 * way they talk about anything else; what gives it away is who owns the product
 * and what the sentence wants the viewer to do.
 *
 * Split by confidence rather than pooled, because the cost of a false positive
 * is a genuinely good moment demoted. `STRONG` phrases have no innocent reading.
 * `WEAK` ones do — "our new" is unremarkable in a hundred contexts — so they
 * carry a third of the weight and rely on arriving together, which in a real ad
 * read they always do.
 */
const PROMOTIONAL_STRONG = [
  'sponsored by',
  'todays sponsor',
  'our sponsor',
  'thanks to our sponsor',
  'thanks to our friends at',
  'thanks to our partners at',
  'brought to you by',
  'partnered with',
  'in partnership with',
  'use code',
  'promo code',
  'discount code',
  'link in the description',
  'link in bio',
  'link below',
  'in stores now',
  'these retailers',
  'at retailers',
  'available now at',
  'go check out their',
];

const PROMOTIONAL_WEAK = [
  'our brand new',
  'our new',
  'we created',
  'they created the',
  'if you wanna try',
  'if you want to try',
  'try them out',
  'try it out',
  'tastes great',
  'taste great',
  'you guys are enjoying',
  'grab yours',
  'get yours',
  'on sale',
  'limited time',
];

/** Weight a single strong marker carries. Two of them saturate the penalty. */
const PROMOTIONAL_STRONG_WEIGHT = 0.6;
/** Weight a single weak marker carries. Alone, one is close to noise. */
const PROMOTIONAL_WEAK_WEIGHT = 0.2;

/**
 * How strongly the clip reads as an advertisement, 0..1.
 *
 * Hits are counted rather than measured as a share of the clip, because a
 * thirty-second Short that is one-third sponsor read is not one-third as bad as
 * one that is entirely sponsor read — both are ads. A ratio would let a long
 * clip bury a plug; a count will not.
 */
export function measurePromotional(normalised: string): number {
  const strong = countPhrases(normalised, PROMOTIONAL_STRONG);
  const weak = countPhrases(normalised, PROMOTIONAL_WEAK);

  return clamp01(strong * PROMOTIONAL_STRONG_WEIGHT + weak * PROMOTIONAL_WEAK_WEIGHT);
}

/** Bare greetings, which are boilerplate on their own when a clip opens on one. */
const GREETING_OPENERS = new Set(['hello', 'hi', 'hey', 'yo', 'greetings', 'welcome']);

/**
 * Words a clip must not end on. Each of them promises something that never
 * arrives, which reads as the video being cut off rather than finished.
 */
const DANGLING_END_WORDS = new Set([
  'and', 'but', 'so', 'because', 'which', 'that', 'the', 'a', 'an', 'to', 'of', 'with', 'for',
  'or', 'if', 'when', 'while', 'my', 'our', 'their', 'his', 'her', 'its', 'is', 'are', 'was',
  'were', 'on', 'in', 'at', 'from', 'as', 'into', 'about', 'like', 'just', 'then', 'very',
  'really', 'more', 'than', 'we', 'i', 'it', 'they',
]);

const HOOK_OPENER_WORDS = new Set([
  'you',
  'your',
  'if',
  'most',
  'nobody',
  'everyone',
  'never',
  'stop',
  'here',
  'the',
  'why',
  'how',
  'what',
  'imagine',
  'listen',
]);

/* -------------------------------------------------------------------------- */
/* Measurements                                                               */
/* -------------------------------------------------------------------------- */

/** Everything the scorer reads off a clip's speech, computed once. */
export interface TextFeatures {
  readonly wordCount: number;
  readonly sentenceCount: number;
  /** Filler words and phrases as a share of all words, 0..1. */
  readonly fillerRatio: number;
  /**
   * How much of the clip is the same thing said twice, 0..1 — the worse of the
   * repeated-word-run and restated-sentence readings. Zero when the text is too
   * short for either to mean anything.
   */
  readonly repetitionRatio: number;
  /** Signals that the clip leans on something said outside it, 0..1. */
  readonly contextDependency: number;
  /** Share of distinct content words, 0..1. A proxy for information density. */
  readonly lexicalVariety: number;
  /** Share of tokens that are numbers — concrete detail. */
  readonly numericRatio: number;
  readonly questionCount: number;
  readonly exclamationCount: number;
  readonly curiosityHits: number;
  readonly emotionHits: number;
  readonly payoffHits: number;
  /** Payoff and resolution phrases in the clip's closing sentences. */
  readonly closingPayoffHits: number;
  /**
   * How strongly the clip's closing lines read as a landing, 0..1 — several
   * cheap signals rather than a phrase list, so a natural ending that never says
   * "the lesson is" can still be credited. See `measurePayoff`.
   */
  readonly payoffStrength: number;
  /** Channel housekeeping as a share of all words, 0..1. */
  readonly boilerplateRatio: number;
  /** How strongly the clip reads as an ad read or product plug, 0..1. */
  readonly promotionalStrength: number;
  /** Words in the first sentence. Short openings land harder. */
  readonly firstSentenceWordCount: number;
  /** The first sentence starts with a word that grabs attention. */
  readonly opensOnHookWord: boolean;
  /** The first sentence starts with a conjunction — mid-thought. */
  readonly opensOnContinuation: boolean;
  /** The first sentence starts with a pronoun pointing outside the clip. */
  readonly opensOnDeictic: boolean;
  /** The clip opens on a greeting, sign-off or call to action. */
  readonly opensOnBoilerplate: boolean;
  /** The first sentence is a complete thought, not a truncated fragment. */
  readonly firstSentenceComplete: boolean;
  /** The speech itself ends on sentence-final punctuation. */
  readonly endsOnSentencePunctuation: boolean;
  /** The last word promises something the clip never delivers. */
  readonly endsOnDanglingWord: boolean;
}

/** Sentences read as the clip's landing, where a payoff is worth counting. */
const CLOSING_SENTENCES = 2;

export function analyseText(text: string): TextFeatures {
  const sentences = splitSentences(text);
  const tokens = tokenise(text);
  const wordCount = tokens.length;
  const normalised = ` ${tokens.join(' ')} `;

  const firstSentence = sentences[0] ?? '';
  const firstTokens = tokenise(firstSentence);
  const firstWord = firstTokens[0] ?? '';
  const lastWord = tokens.at(-1) ?? '';

  const closing = ` ${tokenise(sentences.slice(-CLOSING_SENTENCES).join(' ')).join(' ')} `;
  const firstNormalised = ` ${firstTokens.join(' ')} `;

  return {
    wordCount,
    sentenceCount: sentences.length,
    fillerRatio: safeRatio(countFiller(tokens, normalised, text), wordCount),
    repetitionRatio: measureRepetition(tokens, sentences),
    contextDependency: measureContextDependency(firstTokens, normalised),
    lexicalVariety: safeRatio(new Set(tokens).size, wordCount),
    numericRatio: safeRatio(tokens.filter((t) => /^\p{N}+$/u.test(t)).length, wordCount),
    questionCount: countChar(text, '?'),
    exclamationCount: countChar(text, '!'),
    curiosityHits: tokens.filter((t) => CURIOSITY_WORDS.has(t)).length,
    emotionHits: tokens.filter((t) => EMOTION_WORDS.has(t)).length,
    payoffHits: countPhrases(normalised, PAYOFF_PHRASES),
    closingPayoffHits: countPhrases(closing, PAYOFF_PHRASES) + countPhrases(closing, RESOLUTION_PHRASES),
    payoffStrength: measurePayoff(sentences),
    boilerplateRatio: safeRatio(countBoilerplateWords(normalised), wordCount),
    promotionalStrength: measurePromotional(normalised),
    firstSentenceWordCount: firstTokens.length,
    opensOnHookWord: HOOK_OPENER_WORDS.has(firstWord) || firstSentence.includes('?'),
    opensOnContinuation: CONTINUATION_OPENERS.has(firstWord),
    opensOnDeictic: DEICTIC_WORDS.has(firstWord),
    opensOnBoilerplate:
      GREETING_OPENERS.has(firstWord) || countPhrases(firstNormalised, BOILERPLATE_PHRASES) > 0,
    firstSentenceComplete: firstSentence.length > 0 && endsSentence(firstSentence),
    endsOnSentencePunctuation: text.trim().length > 0 && endsSentence(text),
    endsOnDanglingWord: lastWord.length > 0 && DANGLING_END_WORDS.has(lastWord),
  };
}

/* -------------------------------------------------------------------------- */
/* Payoff                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What each signal is worth. Additive with a clamp rather than averaged: a
 * clip lands for one good reason or for several, and having only one of them
 * should not be read as failing the rest.
 */
const PAYOFF_CREDIT = {
  conclusionMarker: 0.2,
  causal: 0.18,
  contrast: 0.22,
  /** Per word, capped at two — a third one says nothing more. */
  resolutionWord: 0.12,
  answeredQuestion: 0.25,
  informationGain: 0.15,
  decisive: 0.12,
} as const;

/** Below this share of new content words, the ending is restating the setup. */
const STALE_ENDING_GAIN = 0.2;
/** What a stale or thin ending keeps of whatever else it earned. */
const STALE_ENDING_KEEP = 0.6;
const THIN_ENDING_KEEP = 0.5;
/** Content words below which a closing line is too generic to have landed. */
const MIN_CLOSING_CONTENT_WORDS = 3;
/** Longest closing line that still reads as an assertion rather than a ramble. */
const DECISIVE_MAX_WORDS = 24;

/** What is left of a payoff reading once the ending disqualifies itself. */
const UNFINISHED_ENDING = 0.15;
const UNANSWERED_QUESTION_ENDING = 0.2;
const CTA_ENDING = 0.1;

/**
 * How strongly a clip's closing lines read as a landing, 0..1.
 *
 * Deliberately not one phrase list. "The lesson is that writing it down beats
 * repeating it" announces its own payoff; "we are hiring a patch, not a person"
 * lands just as hard and says none of the words a list can look for. So the
 * literal phrases stay as one signal, and six cheaper readings sit beside them:
 * conclusion markers, consequence language, contrastive construction, change
 * vocabulary, a question the clip goes on to answer, and — as much a guard as a
 * signal — whether the final line says anything the clip has not already said.
 *
 * Everything is read off the **final** sentences. A payoff phrase in the middle
 * is a setup for something the viewer will not hear, and earns nothing here.
 *
 * Three endings disqualify themselves whatever else they scored: one that stops
 * mid-clause, one that closes on an unanswered question, and one that closes on
 * channel housekeeping. Those cap the result rather than adjusting it, because
 * no amount of good wording earlier rescues a clip that ends on "smash that
 * like button".
 */
export function measurePayoff(sentences: readonly string[]): number {
  const final = sentences.at(-1) ?? '';
  if (final.trim().length === 0) return 0;

  const closingText = sentences.slice(-CLOSING_SENTENCES).join(' ');
  const closing = ` ${tokenise(closingText).join(' ')} `;
  const finalTokens = tokenise(final);
  const finalNormalised = ` ${finalTokens.join(' ')} `;

  // The literal phrase reading, unchanged: one hit is still full credit, so no
  // clip that scored a payoff before scores less of one now.
  const literal = clamp01(
    countPhrases(closing, PAYOFF_PHRASES) + countPhrases(closing, RESOLUTION_PHRASES),
  );

  const earlier = sentences.slice(0, -1);
  const gain = informationGain(final, earlier);

  let additive = 0;
  if (countPhrases(closing, CONCLUSION_MARKERS) > 0) additive += PAYOFF_CREDIT.conclusionMarker;
  if (countPhrases(closing, CAUSAL_MARKERS) > 0) additive += PAYOFF_CREDIT.causal;
  if (countPhrases(finalNormalised, CONTRAST_MARKERS) > 0) additive += PAYOFF_CREDIT.contrast;

  const resolutionHits = Math.min(2, tokenise(closingText).filter((t) => RESOLUTION_WORDS.has(t)).length);
  additive += resolutionHits * PAYOFF_CREDIT.resolutionWord;

  if (answersAnEarlierQuestion(final, earlier)) additive += PAYOFF_CREDIT.answeredQuestion;
  additive += gain * PAYOFF_CREDIT.informationGain;
  if (isDecisive(final, finalTokens)) additive += PAYOFF_CREDIT.decisive;

  let strength = clamp01(Math.max(literal, additive));

  // An ending that only repeats the setup, or that carries almost no content,
  // is not a landing however it is worded.
  if (gain < STALE_ENDING_GAIN) strength *= STALE_ENDING_KEEP;
  if (contentWords(final).size < MIN_CLOSING_CONTENT_WORDS) strength *= THIN_ENDING_KEEP;

  return clamp01(Math.min(strength, endingCap(final, finalTokens, closing)));
}

/**
 * Words that cannot end a finished sentence whatever punctuation follows them.
 *
 * Narrower than `DANGLING_END_WORDS`, which is read alongside the punctuation
 * check rather than instead of it. Two kinds of ending would otherwise be
 * thrown away wrongly: "writing it down beats repeating it." ends on a pronoun,
 * and "that is a number I am not going to argue with." ends on a stranded
 * preposition. Both are finished sentences, so only conjunctions, determiners
 * and possessives — which genuinely promise a word that never comes — are here.
 */
const UNFINISHABLE_END_WORDS = new Set([
  'and', 'but', 'so', 'because', 'which', 'the', 'a', 'an', 'or', 'if', 'when', 'while',
  'my', 'our', 'their', 'his', 'her', 'its', 'than',
]);

/** The hardest cap the ending's own shape puts on any payoff reading. */
function endingCap(final: string, finalTokens: readonly string[], closing: string): number {
  const lastWord = finalTokens.at(-1) ?? '';
  const unfinished = !endsSentence(final) || UNFINISHABLE_END_WORDS.has(lastWord);

  let cap = 1;
  if (unfinished) cap = Math.min(cap, UNFINISHED_ENDING);
  if (final.includes('?')) cap = Math.min(cap, UNANSWERED_QUESTION_ENDING);
  if (countPhrases(closing, BOILERPLATE_PHRASES) > 0) cap = Math.min(cap, CTA_ENDING);

  return cap;
}

/** Share of the final line's content words that the clip has not used already. */
function informationGain(final: string, earlier: readonly string[]): number {
  const words = contentWords(final);
  if (words.size === 0) return 0;

  const said = contentWords(earlier.join(' '));
  let fresh = 0;
  for (const word of words) if (!said.has(word)) fresh += 1;

  return fresh / words.size;
}

/**
 * Does the closing line answer something the clip asked?
 *
 * A shared content word is the whole test: the question named a subject and the
 * ending is still on it. Crude, but the alternative is a semantic model, and the
 * cost of a false positive here is a quarter of one component.
 */
function answersAnEarlierQuestion(final: string, earlier: readonly string[]): boolean {
  if (final.includes('?')) return false;

  const answer = contentWords(final);
  if (answer.size === 0) return false;

  return earlier.some((sentence) => {
    if (!sentence.includes('?')) return false;
    for (const word of contentWords(sentence)) if (answer.has(word)) return true;
    return false;
  });
}

/** A complete, unhedged, reasonably short assertion. */
function isDecisive(final: string, finalTokens: readonly string[]): boolean {
  if (!endsSentence(final) || final.includes('?')) return false;
  if (finalTokens.length > DECISIVE_MAX_WORDS) return false;
  if (contentWords(final).size < MIN_CLOSING_CONTENT_WORDS) return false;

  return countPhrases(` ${finalTokens.join(' ')} `, HEDGE_PHRASES) === 0;
}

/* -------------------------------------------------------------------------- */

function countFiller(tokens: readonly string[], normalised: string, raw: string): number {
  const single = tokens.filter((token) => FILLER_WORDS.has(token)).length;
  // A two-word phrase costs two words, so the ratio stays in word units.
  const phrases = FILLER_PHRASES.reduce(
    (total, phrase) => total + occurrences(normalised, ` ${phrase} `) * phrase.split(' ').length,
    0,
  );
  // Read off the punctuated text, because position is what makes these filler.
  const discourse = raw.match(DISCOURSE_MARKER_RE)?.length ?? 0;
  return single + phrases + discourse;
}

/** Boilerplate measured in word units, so the ratio is comparable to filler's. */
const countBoilerplateWords = (normalised: string): number =>
  BOILERPLATE_PHRASES.reduce(
    (total, phrase) => total + occurrences(normalised, ` ${phrase} `) * phrase.split(' ').length,
    0,
  );

/**
 * Share of trigrams that are not the first occurrence of themselves.
 *
 * Trigrams rather than words because natural speech repeats words constantly;
 * repeating a three-word run is what actually reads as saying the same thing
 * twice.
 */
export function repeatedTrigramRatio(tokens: readonly string[]): number {
  if (tokens.length < 6) return 0;

  const seen = new Set<string>();
  let repeats = 0;

  for (let i = 0; i + 2 < tokens.length; i += 1) {
    const gram = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
    if (seen.has(gram)) repeats += 1;
    else seen.add(gram);
  }

  return safeRatio(repeats, tokens.length - 2);
}

/**
 * How much of the clip is the speaker saying the same thing again.
 *
 * Two readings, and the worse one wins: exact repeated word runs, and whole
 * sentences that restate an earlier one in different words. The second catches
 * what trigrams cannot — "it changed everything for us" followed by "it really
 * changed everything for our team" shares no trigram but is one point made
 * twice, which is a third of a Short spent going nowhere.
 */
export function measureRepetition(tokens: readonly string[], sentences: readonly string[]): number {
  return Math.max(repeatedTrigramRatio(tokens), restatedSentenceRatio(sentences));
}

/** Similarity above which a sentence is a restatement of an earlier one. */
const RESTATEMENT_SIMILARITY = 0.6;

/**
 * Share of sentences that restate an earlier sentence, 0..1.
 *
 * Only sentences with enough content words to be a claim are compared; two
 * three-word asides looking alike says nothing about the clip.
 */
export function restatedSentenceRatio(sentences: readonly string[]): number {
  const meaningful = sentences.filter((sentence) => contentWords(sentence).size >= 3);
  if (meaningful.length < 2) return 0;

  let restated = 0;
  for (let i = 1; i < meaningful.length; i += 1) {
    const later = meaningful[i]!;
    for (let j = 0; j < i; j += 1) {
      if (textSimilarity(meaningful[j]!, later) > RESTATEMENT_SIMILARITY) {
        restated += 1;
        break;
      }
    }
  }

  return safeRatio(restated, meaningful.length);
}

/**
 * How much the opening leans on material the clip does not contain.
 *
 * Weighted towards the *first* sentence: a pronoun in the middle of a clip
 * usually has its antecedent inside the clip, whereas one in the first line
 * almost never does.
 */
function measureContextDependency(firstTokens: readonly string[], normalised: string): number {
  const opener = firstTokens[0] ?? '';
  const head = firstTokens.slice(0, 8);

  let score = 0;
  if (CONTINUATION_OPENERS.has(opener)) score += 0.35;
  if (DEICTIC_WORDS.has(opener)) score += 0.4;
  score += 0.12 * head.slice(1).filter((token) => DEICTIC_WORDS.has(token)).length;
  score += 0.3 * countPhrases(normalised, BACKREFERENCE_PHRASES);

  return clamp01(score);
}

const countPhrases = (normalised: string, phrases: readonly string[]): number =>
  phrases.reduce((total, phrase) => total + occurrences(normalised, ` ${phrase} `), 0);

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + 1);
  }
  return count;
}

const countChar = (text: string, char: string): number =>
  text.split('').filter((c) => c === char).length;

/* -------------------------------------------------------------------------- */
/* Similarity                                                                 */
/* -------------------------------------------------------------------------- */

/** Words too common to say anything about what a clip is *about*. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'is',
  'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'i', 'you', 'we', 'they', 'he', 'she',
  'as', 'so', 'do', 'does', 'did', 'not', 'have', 'has', 'had', 'my', 'your', 'our', 'their',
  'me', 'us', 'them', 'what', 'when', 'how', 'just', 'like', 'really', 'about', 'from', 'by',
]);

export const contentWords = (text: string): Set<string> =>
  new Set(tokenise(text).filter((token) => token.length > 2 && !STOP_WORDS.has(token)));

/**
 * Jaccard overlap of content words, 0..1.
 *
 * Crude by design: it is used to notice that two clips are about the same
 * thing, a judgement where a false positive only costs us a slightly weaker
 * third pick.
 */
export function textSimilarity(a: string, b: string): number {
  const left = contentWords(a);
  const right = contentWords(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;

  return shared / (left.size + right.size - shared);
}

/** How many words a hook may sit behind and still count as opening the clip. */
const HOOK_LEAD_WORDS = 4;

/**
 * Does `quote` sit at the start of `text`?
 *
 * A *position* check, not a verbatim one — `verifyQuote` remains the guard for
 * whether a quote was said at all, and this never replaces it. It exists
 * because a line lifted from the middle of a clip is a good line but not a
 * hook: the viewer hears the opening, not the best sentence.
 */
export function quoteOpensText(quote: string, text: string): boolean {
  const needle = tokenise(quote);
  const haystack = tokenise(text);
  if (needle.length === 0 || haystack.length === 0) return false;

  const window = haystack.slice(0, needle.length + HOOK_LEAD_WORDS).join(' ');
  return ` ${window} `.includes(` ${needle.join(' ')} `);
}

/* -------------------------------------------------------------------------- */

export const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
};

const safeRatio = (part: number, whole: number): number => (whole > 0 ? clamp01(part / whole) : 0);
