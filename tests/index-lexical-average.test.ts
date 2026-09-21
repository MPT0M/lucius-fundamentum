/**
 * BM25's average length is taken over the documents the lexical arm can
 * retrieve, and a page image is not one of them.
 *
 * This file exists because the change it holds was invisible to the suite.
 * The one mixed corpus elsewhere asserts vectors, positions and hashes and
 * never a score, and in an image-only corpus `totalTokens / lexicalCount`
 * and `totalTokens / chunks.length` both evaluate to zero — so reverting the
 * fix left everything green. A correction nothing can distinguish is a
 * correction nobody can keep.
 */
import { describe, expect, it } from 'vitest';
import { createIndex } from '../src/index-build.js';
import { createTokenizer } from '../src/tokenizer.js';
import { RSLP_S_FOLDED } from '../src/stemmer.js';
import type { SourceDoc } from '../src/chunker.js';

const tokenizer = createTokenizer({ stemmer: RSLP_S_FOLDED });
const page = { data: 'QkFTRTY0', mimeType: 'image/png' } as const;

const TEXT_DOCS: readonly SourceDoc[] = [
    { id: 'serie', text: 'A resistencia equivalente em serie e maior que a maior resistencia.', pageNumber: 1 },
    { id: 'paralelo', text: 'Em paralelo a equivalente e menor que a menor das resistencias.', pageNumber: 2 },
];
const SCANS: readonly SourceDoc[] = [
    { id: 'folha-3', text: '', page, pageNumber: 3 },
    { id: 'folha-4', text: '', page, pageNumber: 4 },
];

const averageOf = (docs: readonly SourceDoc[]): number =>
    createIndex(docs, { tokenizer }).serialize().bm25.averageLength;

describe('the average length ignores page images, which no query can reach', () => {
    it('adding scanned pages to a corpus does not move the average', () => {
        // The decisive assertion. Averaging over every chunk would divide the
        // same token total by 4 instead of 2, halving the figure that `b`
        // normalises against — so every real passage would look twice as long
        // as the corpus, and be penalised for it. Nothing would error.
        const withoutScans = averageOf(TEXT_DOCS);
        const withScans = averageOf([...TEXT_DOCS, ...SCANS]);

        expect(withoutScans).toBeGreaterThan(0);
        expect(withScans).toBe(withoutScans);
    });

    it('the average equals the token total over the TEXT chunks only', () => {
        // Computed from the artifact rather than restated, so the expectation
        // cannot drift from the tokenizer the index actually used.
        const artifact = createIndex([...TEXT_DOCS, ...SCANS], { tokenizer }).serialize();
        const textChunks = artifact.chunks.filter((c) => c.text !== '');
        const totalTokens = Object.values(artifact.postings)
            .flat()
            .reduce((sum, [, times]) => sum + times, 0);

        expect(textChunks).toHaveLength(2);
        expect(artifact.chunks).toHaveLength(4);
        expect(artifact.bm25.averageLength).toBeCloseTo(totalTokens / textChunks.length, 10);
        // And it is NOT the whole-chunk average, which is what the code used
        // to compute. Spelled out so the difference is visible in the file.
        expect(artifact.bm25.averageLength).not.toBeCloseTo(totalTokens / artifact.chunks.length, 10);
    });

    it('a corpus of nothing but pages is legal, and its average is zero', () => {
        // The guard that refuses "chunks but no tokens" asks about the
        // lexical collection now. This corpus has none, by construction, and
        // the lexical arm correctly returns nothing from it.
        expect(() => createIndex(SCANS, { tokenizer })).not.toThrow();
        expect(averageOf(SCANS)).toBe(0);
    });

    it('text chunks that produce no tokens are still refused', () => {
        // The guard must not have been widened into uselessness: a corpus the
        // tokenizer drops entirely is still the configuration error it always
        // was, and the message still says so.
        const unreadable: readonly SourceDoc[] = [{ id: 'simbolos', text: '¤¤¤ ¤¤¤.', pageNumber: 1 }];
        expect(() => createIndex(unreadable, { tokenizer })).toThrow(/0 tokens/u);
        expect(() => createIndex(unreadable, { tokenizer })).toThrow(/text chunks/u);
    });
});
