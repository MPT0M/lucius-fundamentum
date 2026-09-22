/**
 * The example's decisions, pinned.
 *
 * It lives here rather than in `tests/` for the reason `bench/src` does: a
 * `.ts` test cannot import this `.js` module without `allowJs`, and turning
 * that on for the main type-check config drags in files this example has no
 * business touching. So the test sits beside its subject, type-checked by
 * `tsconfig.example.json` and pulled into the suite by one glob — the glob
 * `example-scaffold.test.ts` pins, for the same silent-drop reason
 * `scaffold.test.ts` pins the bench's.
 *
 * What is worth a test here is not that the page renders. It is the two rules
 * the bench must get right for the library's own promises to survive the trip
 * to a screen: never collapsing the two reasons the dense arm is off, and
 * never cutting text anywhere but a code point boundary.
 */

import { describe, it, expect } from 'vitest';
import { describeArm, snippetOf, resultForScreen, documentFromPastedText, buildLexicalIndex } from './bancada.js';

/** @typedef {import('../../dist/index.js').SearchResult} SearchResult */

/**
 * @param {string} text
 * @param {number} [pageNumber]
 * @returns {SearchResult}
 */
function hit(text, pageNumber) {
    const span = { start: 0, end: text.length };
    return pageNumber === undefined
        ? { chunk: { id: 'c#0', documentId: 'd', text, span }, score: 1, rank: 1 }
        : { chunk: { id: 'c#0', documentId: 'd', text, span, pageNumber }, score: 1, rank: 1 };
}

describe('the bench says which negative it is looking at', () => {
    it('offers embedding for `absent` and for nothing else', () => {
        // `DenseArm`'s docblock states the cost of merging them: a caller that
        // does "offers 're-read 40 documents' to someone who only had to
        // supply a key". `needs-provider` means the vectors are already in
        // the artifact and one argument turns the arm on.
        expect(describeArm('absent').offersEmbedding).toBe(true);
        expect(describeArm('needs-provider').offersEmbedding).toBe(false);
        expect(describeArm('ready').offersEmbedding).toBe(false);
    });

    it('gives the three states three different sentences', () => {
        const said = ['ready', 'needs-provider', 'absent'].map((a) =>
            describeArm(/** @type {'ready' | 'needs-provider' | 'absent'} */ (a)).headline,
        );
        expect(new Set(said).size).toBe(3);
    });

    it('never tells someone who already has vectors to pay for them again', () => {
        const detail = describeArm('needs-provider').detail;
        expect(detail).toContain('nothing is embedded a second time');
        expect(detail).not.toContain('costs money');
        // The contrast is the point: `absent` is the one state where that
        // sentence is honest.
        expect(describeArm('absent').detail).toContain('costs money');
    });
});

describe('the bench cuts text where the library would', () => {
    it('does not split a character in half', () => {
        // 𝒳 is one code point and two UTF-16 units, so `text.slice(0, 5)` ends
        // inside it and renders a replacement glyph — in a package whose first
        // promise is that it never loses a character.
        const text = 'ab𝒳cd efgh';
        const cut = snippetOf(hit(text), 5);

        expect(cut).toBe('ab𝒳cd…');
        expect([...cut]).toHaveLength(6);
        // The naive version, for contrast: this is what the assertion above
        // exists to keep out. Without it, a passing test proves only that
        // some string came back.
        expect(text.slice(0, 5)).not.toBe('ab𝒳cd');
    });

    it('leaves a short chunk alone rather than marking it truncated', () => {
        expect(snippetOf(hit('short'), 40)).toBe('short');
    });
});

describe('the bench carries the page number and never the page', () => {
    it('passes `pageNumber` through, and undefined when there is none', () => {
        expect(resultForScreen(hit('x', 7), 10).pageNumber).toBe(7);
        expect(resultForScreen(hit('x'), 10).pageNumber).toBeUndefined();
    });
});

describe('the bench indexes what was pasted', () => {
    it('finds a passage by a word that is in it', () => {
        const doc = documentFromPastedText(
            'O prazo para a manifestacao e de quinze dias corridos. A contagem exclui o dia do inicio.',
            'pasted',
        );
        const index = buildLexicalIndex([doc]);
        const hits = index.searchLexical('prazo manifestacao');

        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0]?.chunk.documentId).toBe('pasted');
    });

    it('reports `absent` before anything has been embedded', () => {
        const index = buildLexicalIndex([documentFromPastedText('qualquer texto', 'pasted')]);
        expect(index.denseArm).toBe('absent');
    });
});
