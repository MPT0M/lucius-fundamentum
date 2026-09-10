import { describe, it, expect } from 'vitest';
import {
    luceneIdf,
    bm25TermScore,
    bm25Score,
    DEFAULT_BM25_PARAMS,
    type CorpusStats,
} from '../src/bm25.js';
import { classicIdf } from '../bench/src/df-regime.js';
import { createTokenizer } from '../src/tokenizer.js';
import { RSLP_S_FOLDED } from '../src/stemmer.js';

describe('bm25 — the idf never argues backwards', () => {
    it('is positive for every document frequency, including a term in every chunk', () => {
        for (let df = 1; df <= 355; df += 1) expect(luceneIdf(355, df)).toBeGreaterThan(0);
    });

    it('falls as the term spreads, and keeps falling past half the corpus', () => {
        const spread = [1, 10, 100, 178, 200, 300, 355].map((df) => luceneIdf(355, df));
        for (let i = 1; i < spread.length; i += 1) expect(spread[i]!).toBeLessThan(spread[i - 1]!);
    });

    it('the classic form crosses zero exactly where this one does not', () => {
        // Same corpus, same term, opposite verdicts. `nao` sits in 344 of 355
        // chunks; under the classic idf a chunk that CONTAINS it is pushed
        // below one that lacks it.
        expect(classicIdf(355, 344)).toBeLessThan(0);
        expect(luceneIdf(355, 344)).toBeGreaterThan(0);
    });
});

describe('bm25 — term frequency saturates', () => {
    const stats: CorpusStats = { chunkCount: 100, averageLength: 200 };

    it('a second occurrence is worth less than the first', () => {
        const one = bm25TermScore(1, 200, 10, stats);
        const two = bm25TermScore(2, 200, 10, stats);
        const three = bm25TermScore(3, 200, 10, stats);
        expect(two - one).toBeGreaterThan(0);
        expect(three - two).toBeLessThan(two - one);
    });

    it('the score approaches a ceiling instead of growing without bound', () => {
        const ceiling = luceneIdf(100, 10) * (DEFAULT_BM25_PARAMS.k1 + 1);
        expect(bm25TermScore(1000, 200, 10, stats)).toBeLessThan(ceiling);
        expect(bm25TermScore(1000, 200, 10, stats)).toBeGreaterThan(ceiling * 0.98);
    });

    it('an absent term contributes nothing rather than something negative', () => {
        expect(bm25TermScore(0, 200, 10, stats)).toBe(0);
        expect(bm25TermScore(3, 200, 0, stats)).toBe(0);
    });

    it('a higher k1 delays saturation, which is what the knob is for', () => {
        // The ratio between three occurrences and one. `b` is held fixed so
        // only saturation moves; without this, `k1` is a number in the
        // signature and nothing says what turning it does.
        const ratio = (k1: number) =>
            bm25TermScore(3, 200, 10, stats, { k1, b: 0.75 }) /
            bm25TermScore(1, 200, 10, stats, { k1, b: 0.75 });
        expect(ratio(2)).toBeGreaterThan(ratio(0.5));
        expect(ratio(0.5)).toBeGreaterThan(1);
    });

    it('a term repeated in the query counts once per occurrence', () => {
        const term = { termFrequency: 2, documentFrequency: 10 };
        expect(bm25Score([term, term], 200, stats)).toBeCloseTo(bm25Score([term], 200, stats) * 2, 12);
    });
});

describe('bm25 — length is punished, and by how much is the knob', () => {
    const stats: CorpusStats = { chunkCount: 100, averageLength: 200 };

    it('a long chunk scores below a short one holding the term as often', () => {
        expect(bm25TermScore(3, 400, 10, stats)).toBeLessThan(bm25TermScore(3, 100, 10, stats));
    });

    it('b at zero ignores length entirely', () => {
        const flat = { k1: 1.2, b: 0 };
        expect(bm25TermScore(3, 400, 10, stats, flat)).toBeCloseTo(bm25TermScore(3, 50, 10, stats, flat), 12);
    });

    it('a chunk of average length is unaffected by b', () => {
        for (const b of [0, 0.25, 0.75, 1]) {
            expect(bm25TermScore(3, 200, 10, stats, { k1: 1.2, b })).toBeCloseTo(
                bm25TermScore(3, 200, 10, stats, { k1: 1.2, b: 0 }),
                12,
            );
        }
    });

    it('an index with no length yet does not divide by zero', () => {
        expect(Number.isFinite(bm25TermScore(1, 0, 1, { chunkCount: 1, averageLength: 0 }))).toBe(true);
    });
});

/**
 * The test that ties §3 to §5.
 *
 * Those two decisions look separate — one refuses a stop-word list, the other
 * fixes the idf variant — and they are one decision. The refusal is argued on
 * the grounds that BM25 already grades a ubiquitous term toward zero, so a
 * list is a blunt instrument. That argument only holds while the grading is
 * TOWARD zero. Under the classic idf `nao` is not graded down, it is
 * inverted, and the refusal would be indefensible.
 *
 * So one test fails if somebody swaps the idf, AND fails if somebody adds
 * `nao` to a stop-word list. One dependency, one test.
 *
 * The fixture needs `df > N / 2` or it proves nothing: with two or three
 * chunks the classic idf is still positive and both formulas agree.
 */
describe('bm25 — a search for "não" ranks the chunk that says it above the chunk that does not', () => {
    const tokenizer = createTokenizer({ stemmer: RSLP_S_FOLDED });

    // Five chunks, four of them containing the negation: df = 4 of 5.
    const CHUNKS = [
        'O contrato não sustenta essa cláusula.',
        'A norma não alcança o caso concreto.',
        'O parecer não conclui pela nulidade.',
        'A decisão não transita em julgado.',
        'O contrato sustenta essa cláusula.',
    ];

    const indexed = CHUNKS.map((text) => tokenizer.tokenize(text).map((t) => t.term));
    const chunkCount = indexed.length;
    const averageLength = indexed.reduce((sum, terms) => sum + terms.length, 0) / chunkCount;
    const stats: CorpusStats = { chunkCount, averageLength };

    const documentFrequency = (term: string) => indexed.filter((terms) => terms.includes(term)).length;

    const scoreOf = (chunkIndex: number, query: string) => {
        const terms = tokenizer.tokenize(query).map((t) => t.term);
        const inChunk = indexed[chunkIndex]!;
        return bm25Score(
            terms.map((term) => ({
                termFrequency: inChunk.filter((t) => t === term).length,
                documentFrequency: documentFrequency(term),
            })),
            inChunk.length,
            stats,
        );
    };

    it('the fixture is in the regime where the two formulas disagree', () => {
        expect(documentFrequency('nao')).toBe(4);
        expect(documentFrequency('nao') / chunkCount).toBeGreaterThan(0.5);
        expect(classicIdf(chunkCount, 4)).toBeLessThan(0);
        expect(luceneIdf(chunkCount, 4)).toBeGreaterThan(0);
    });

    it('the negation survives tokenization and stemming, so a list is the only way to lose it', () => {
        expect(tokenizer.tokenize('não').map((t) => t.term)).toEqual(['nao']);
    });

    it('and the chunk holding it wins', () => {
        const withNegation = scoreOf(0, 'não sustenta');
        const withoutNegation = scoreOf(4, 'não sustenta');
        expect(withNegation).toBeGreaterThan(withoutNegation);
    });

    it('which is exactly what the classic idf would reverse', () => {
        // The same comparison scored with the form this package refuses. If
        // this ever stops being a reversal, the argument of §5 has changed.
        const classicScore = (chunkIndex: number, query: string) => {
            const terms = tokenizer.tokenize(query).map((t) => t.term);
            const inChunk = indexed[chunkIndex]!;
            let total = 0;
            for (const term of terms) {
                const tf = inChunk.filter((t) => t === term).length;
                const df = documentFrequency(term);
                if (tf === 0 || df === 0) continue;
                const { k1, b } = DEFAULT_BM25_PARAMS;
                const norm = inChunk.length / averageLength;
                total += classicIdf(chunkCount, df) * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * norm)));
            }
            return total;
        };
        expect(classicScore(0, 'não sustenta')).toBeLessThan(classicScore(4, 'não sustenta'));
    });
});
