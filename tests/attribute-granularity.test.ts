/**
 * `granularity` names the density that already existed, and the tests here
 * exist to prove that naming it changed nothing.
 *
 * The risk in this kind of commit is not a wrong result, it is a default that
 * gets published and then quietly disagrees with the path that actually runs.
 * So the assertions compare the named mode against the absent one on real
 * output, rather than checking that the constant holds the string.
 */
import { describe, it, expect } from 'vitest';
import {
    createIndex,
    createTokenizer,
    attributeLexical,
    DEFAULT_GRANULARITY,
    DEFAULT_ATTRIBUTE_OPTIONS,
    type SourceDoc,
    type SearchResult,
} from '../src/index.js';

const DOC: SourceDoc = {
    id: 'lei',
    text:
        'O prazo para recurso é de quinze dias corridos. ' +
        'A contagem exclui o dia do começo e inclui o do vencimento. ' +
        'O relator pode conceder efeito suspensivo ao agravo.',
};

const tokenizer = createTokenizer();

function search(query: string): readonly SearchResult[] {
    const index = createIndex([DOC], {
        tokenizer,
        chunkOptions: { maxChunkCodePoints: 80, maxOverlapCodePoints: 40 },
    });
    return index.searchLexical(query, { topK: 6 });
}

const ANSWER =
    'O prazo para recurso é de quinze dias corridos. ' +
    'O relator pode conceder efeito suspensivo ao agravo.';

describe("granularity — naming 'cluster' does not move a single anchor", () => {
    it('produces byte-identical spans whether the mode is named or left out', () => {
        const results = search('prazo recurso relator suspensivo');
        const named = attributeLexical(ANSWER, results, { tokenizer, granularity: 'cluster' });
        const absent = attributeLexical(ANSWER, results, { tokenizer });

        expect(named.spans).toEqual(absent.spans);
        expect(named.rungs).toEqual(absent.rungs);
        // Not a vacuous comparison: the fixture really does produce anchors.
        expect(named.spans.length).toBeGreaterThan(0);
    });

    it('states the default in the object whose job is to state defaults', () => {
        // The compiler does not ask for this: `Omit` preserves optionality, so
        // a new optional field leaves the literal compiling without it. This
        // assertion is the guard that replaces the one TypeScript will not
        // give.
        expect(DEFAULT_ATTRIBUTE_OPTIONS.granularity).toBe(DEFAULT_GRANULARITY);
        expect(DEFAULT_GRANULARITY).toBe('cluster');
    });

    it('agrees with the path that runs when the caller passes the default object', () => {
        const results = search('prazo recurso relator suspensivo');
        const fromDefaults = attributeLexical(ANSWER, results, {
            tokenizer,
            ...DEFAULT_ATTRIBUTE_OPTIONS,
        });
        const absent = attributeLexical(ANSWER, results, { tokenizer });
        expect(fromDefaults.spans).toEqual(absent.spans);
    });
});
