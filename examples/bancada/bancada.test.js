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
import {
    describeArm,
    snippetOf,
    resultForScreen,
    documentFromPastedText,
    buildLexicalIndex,
    attributeWithoutKey,
    markedAnswer,
    describeRungs,
} from './bancada.js';

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

describe('the bench reads the rung counts without lying about them', () => {
    /**
     * @param {Partial<import('../../dist/index.js').RungCounts>} rungs
     * @param {import('../../dist/index.js').ProviderFailure} [failure]
     * @returns {import('../../dist/index.js').Attribution}
     */
    function attribution(rungs, failure) {
        const counts = { lexical: 0, vetoed: 0, dense: 0, unattributed: 0, ...rungs };
        const base = { text: 'x', spans: [], sources: [], rungs: counts };
        return failure === undefined ? base : { ...base, providerFailure: failure };
    }

    it('keeps `vetoed` out of the partition', () => {
        // `lexical + dense + unattributed` partition the clauses examined;
        // `vetoed` crosses the last two and never the first, so adding all
        // four counts some clauses twice.
        const read = describeRungs(attribution({ lexical: 6, dense: 2, unattributed: 4, vetoed: 3 }), true);
        expect(read.examined).toBe(12);
        expect(read.vetoed).toBe(3);
    });

    it('says the rung never ran when no provider was supplied', () => {
        const read = describeRungs(attribution({ lexical: 3, unattributed: 2 }), false);
        expect(read.note).toContain('did not run: no provider');
        expect(read.retryWorthOffering).toBe(false);
    });

    it('never asks for a key when the failure says one was already used', () => {
        // The defect this guards: `rungs.dense === 0` is produced both by an
        // absent provider and by one that failed, and the library carries
        // `providerFailure` precisely because that degradation is otherwise
        // silent. Reading the count alone tells someone to supply a key they
        // supplied already.
        const failed = attribution({ lexical: 3, dense: 0, unattributed: 2 }, {
            reason: 'quota',
            retryable: true,
            cause: new Error('429'),
        });
        const read = describeRungs(failed, true);

        expect(read.dense).toBe(0);
        expect(read.note).toContain('tried and failed');
        expect(read.note).not.toContain('no provider');
        expect(read.retryWorthOffering).toBe(true);
    });

    it('does not offer a retry the status says is pointless', () => {
        const failed = attribution({}, { reason: 'auth', retryable: false, cause: new Error('401') });
        expect(describeRungs(failed, true).retryWorthOffering).toBe(false);
    });
});

describe('the bench attributes an answer with no key at all', () => {
    const SOURCE =
        'O prazo para a manifestacao e de quinze dias corridos. ' +
        'A contagem exclui o dia do inicio e inclui o do vencimento. ' +
        'O recurso cabivel contra a decisao final e o agravo.';

    it('marks a clause the source supports, and lists what supports it', () => {
        const index = buildLexicalIndex([documentFromPastedText(SOURCE, 'lei')]);
        const answer = 'O prazo para a manifestacao e de quinze dias corridos.';
        const attributed = attributeWithoutKey(answer, index.searchLexical(answer));

        expect(attributed.spans.length).toBeGreaterThan(0);
        expect(attributed.sources.length).toBeGreaterThan(0);
        expect(attributed.rungs.dense).toBe(0);

        const marked = markedAnswer(attributed);
        // The formatter wrote markers in, so the text is no longer the input.
        expect(marked.text).not.toBe(answer);
        expect(marked.text).toContain('[1]');
        expect(marked.sources[0]?.marker).toBe(1);
        expect(marked.sources[0]?.documentId).toBe('lei');
    });

    it('counts clauses and markers separately, because coalescence merges them', () => {
        // Measured on this fixture: two clauses find support and ONE marker is
        // written, because both rest on the same passage. A screen that reads
        // `rungs.lexical` and calls it markers sends the reader looking for a
        // second one that was never written.
        const index = buildLexicalIndex([documentFromPastedText(SOURCE, 'lei')]);
        const answer = 'O prazo e de quinze dias corridos. O recurso cabivel e o agravo.';
        const attributed = attributeWithoutKey(answer, index.searchLexical(answer));
        const counts = describeRungs(attributed, false);

        expect(counts.lexical).toBe(2);
        expect(counts.markers).toBe(1);
        expect(markedAnswer(attributed).text.match(/\[\d+\]/g)).toHaveLength(counts.markers);
    });

    it('costs no network, which is what makes it the no-key half', () => {
        // `attributeLexical` is synchronous. A version that reached the
        // network could not be, and the signature is the proof: there is no
        // promise to await.
        const index = buildLexicalIndex([documentFromPastedText(SOURCE, 'lei')]);
        const returned = attributeWithoutKey('O recurso cabivel e o agravo.', index.searchLexical('recurso agravo'));
        expect(returned).not.toBeInstanceOf(Promise);
        expect(returned.providerFailure).toBeUndefined();
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
