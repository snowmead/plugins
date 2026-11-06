/* The writing checks the builds share. guided-review's text and thinkr's specs are written about 80% of the way to
   ASD-STE100 Simplified Technical English, and STE keeps each sentence short: the builds warn past LONG_SENTENCE
   words. */

/** The word count past which a build warns on a sentence: split it in two. */
export const LONG_SENTENCE = 25;

/** The sentences of a text, with code spans, decimals and abbreviations kept whole. A code span stands in as a capital
    (one word), so a sentence that starts with one is a sentence of its own. */
export const sentences = (s: unknown) => String(s ?? '')
  .replace(/`[^`]*`/g, 'X').replace(/\b(e\.g|i\.e|etc|vs)\./gi, '$1').replace(/(\d)\.(\d)/g, '$1$2')
  .split(/(?<=[.!?:;])\s+(?=[^a-z])/).map((x) => x.trim()).filter(Boolean);

/** The sentences of a text longer than LONG_SENTENCE words, each with its word count and its first six words to
    name it in a warning. */
export const longSentences = (s: unknown) => sentences(s)
  .map((text) => ({ text, words: text.split(/\s+/).filter(Boolean).length }))
  .filter((x) => x.words > LONG_SENTENCE)
  .map((x) => ({ words: x.words, start: x.text.split(/\s+/).slice(0, 6).join(' ') }));
