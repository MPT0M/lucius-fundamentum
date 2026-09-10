import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { measureDfRegime, classicIdf } from '../bench/src/df-regime.js';
import { createTokenizer } from '../src/tokenizer.js';
import { RSLP_S_FOLDED } from '../src/stemmer.js';
import { DEFAULT_CHUNK_OPTIONS } from '../src/chunker.js';

const text = readFileSync(
    fileURLToPath(new URL('../bench/corpus/public/machado-memorias-posthumas.txt', import.meta.url)),
    'utf8',
);
const doc = { id: 'machado-memorias-posthumas', title: 'Memórias Póstumas', text };

const measure = (stemmed: boolean) =>
    measureDfRegime(
        doc,
        DEFAULT_CHUNK_OPTIONS,
        createTokenizer(stemmed ? { stemmer: RSLP_S_FOLDED } : {}),
    );

// Measured once. Chunking and tokenizing a whole novel per `it` cost ten
// seconds of the suite; the regime does not change between assertions.
const withStemmer = measure(true);
const withoutStemmer = measure(false);

describe('df regime — the classic idf goes negative, and on which terms', () => {
    it('is negative exactly when a term is in more than half the chunks', () => {
        expect(classicIdf(100, 51)).toBeLessThan(0);
        expect(classicIdf(100, 50)).toBeCloseTo(0, 10);
        expect(classicIdf(100, 49)).toBeGreaterThan(0);
    });

    it('the term that decided the variant is inverted, not graded down', () => {
        const { negativeIdfTerms, chunkCount } = withStemmer;
        const negation = negativeIdfTerms.find((t) => t.term === 'nao')!;
        expect(negation.documentFrequency / chunkCount).toBeGreaterThan(0.9);
        // Under the classic form a chunk containing the negation ranks BELOW
        // one that lacks it. Lucene's form adds one inside the logarithm and
        // grades toward zero instead, which is the whole argument of §5.
        expect(negation.classicIdf).toBeLessThan(-3);
        expect(Math.log(1 + Math.exp(negation.classicIdf))).toBeGreaterThan(0);
    });
});

/**
 * The re-measurement the plan asks for before the lexical engine is built.
 *
 * The first count was taken with no stemmer. A stemmer collapses forms, which
 * raises document frequency, which can push terms across the line — so the
 * number has to be taken again under the default that ships.
 *
 * The SET is pinned rather than a property of it. There is no predicate in
 * this package that separates a content word from a function word, and
 * writing one would reintroduce through the tests the stop-word list §3
 * refuses. A frozen set fails when the composition changes, a human reads the
 * diff, and the decision stays where it belongs.
 */
describe('df regime — pinned under the default configuration', () => {
    const NEGATIVE_UNDER_RSLP_S = [
        'a', 'de', 'e', 'o', 'que', 'um', 'nao', 'da', 'do', 'se', 'me', 'uma', 'com', 'eu',
        'era', 'as', 'mas', 'ao', 'os', 'no', 'lhe', 'em', 'na', 'para', 'mais', 'como',
        'meu', 'por', 'capitulo',
    ];

    it('twenty-nine terms of nine thousand, and these exactly', () => {
        const { negativeIdfTerms, vocabularySize, chunkCount } = withStemmer;
        expect(chunkCount).toBe(355);
        expect(vocabularySize).toBe(9051);
        expect(negativeIdfTerms.map((t) => t.term)).toEqual(NEGATIVE_UNDER_RSLP_S);
    });

    it('they are a third of a percent of the vocabulary and two fifths of the running text', () => {
        const { negativeIdfTerms, vocabularySize, negativeIdfOccurrenceShare } = withStemmer;
        expect(negativeIdfTerms.length / vocabularySize).toBeLessThan(0.004);
        expect(negativeIdfOccurrenceShare).toBeGreaterThan(0.39);
        expect(negativeIdfOccurrenceShare).toBeLessThan(0.41);
    });

    it('the stemmer changed the set by one swap and not the count', () => {
        const before = new Set(withoutStemmer.negativeIdfTerms.map((t) => t.term));
        const after = new Set(withStemmer.negativeIdfTerms.map((t) => t.term));
        expect(after.size).toBe(before.size);
        // `dos` leaves because the stemmer merges it into `do`; `meu` crosses
        // the line in its place. Both are function words, so the criterion the
        // plan set — a content term crossing — did not fire on this diff.
        expect([...before].filter((t) => !after.has(t))).toEqual(['dos']);
        expect([...after].filter((t) => !before.has(t))).toEqual(['meu']);
    });

    it('one of the twenty-nine is NOT a function word, and it argues for both decisions', () => {
        // The plan describes these as "29 function words". `capitulo` is not
        // one; it is over half the chunks because this corpus is one novel of
        // a hundred and sixty chapters. It was there before the stemmer too.
        //
        // It is the sharpest case for the variant chosen in §5: a word that
        // carries meaning, INVERTED by the classic form. And it is a case for
        // the refusal in §3, not against it — no stop-word list of Portuguese
        // contains `capitulo`, so a list would not have caught it, while the
        // idf grades it to a small positive weight, which is correct: in this
        // corpus it does not discriminate.
        const term = withStemmer.negativeIdfTerms.find((t) => t.term === 'capitulo')!;
        expect(term.classicIdf).toBeLessThan(0);
        expect(Math.log(1 + Math.exp(term.classicIdf))).toBeGreaterThan(0.5);
    });
});
