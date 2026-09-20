import { describe, it, expect } from 'vitest';
import { clausesOf } from '../src/attribute.js';
import {
    attributeLexical,
    createIndex,
    createTokenizer,
    countCodePoints,
    type SourceDoc,
    type SearchResult,
} from '../src/index.js';

const DOC: SourceDoc = {
    id: 'lei',
    text:
        'O prazo para recurso é de 15 dias corridos. ' +
        'A contagem exclui o dia inicial e inclui o do vencimento. ' +
        'O relator pode conceder efeito suspensivo ao agravo. ' +
        'A perícia contábil será custeada pela parte requerente.',
};

const tokenizer = createTokenizer();

function search(query: string): readonly SearchResult[] {
    const index = createIndex([DOC], { tokenizer, chunkOptions: { maxChunkCodePoints: 80, maxOverlapCodePoints: 40 } });
    return index.searchLexical(query, { topK: 6 });
}

describe('attributeLexical — the door that needs no key', () => {
    it('points a clause at the passage that carries it, in document offsets', () => {
        const results = search('prazo recurso dias');
        const out = attributeLexical('O prazo para recurso é de 15 dias corridos.', results, {
            tokenizer,
        });
        expect(out.spans).toHaveLength(1);
        const span = out.spans[0]!;
        expect(span.documentId).toBe('lei');
        expect(span.resolvedBy).toBe('lexical');
        // The source span is the document's, and reading it back gives the
        // sentence that supports the clause.
        const points = Array.from(DOC.text);
        expect(points.slice(span.sourceSpan.start, span.sourceSpan.end).join('')).toBe(
            'O prazo para recurso é de 15 dias corridos.',
        );
    });

    it('leaves the answer untouched and hands back the results as received', () => {
        const results = search('prazo recurso');
        const text = 'O prazo para recurso é de 15 dias corridos.';
        const out = attributeLexical(text, results, { tokenizer });
        expect(out.text).toBe(text);
        // `sources` is the input, in order: the marker's number is a position
        // in it, so trimming it to what was cited would move every number.
        expect(out.sources).toBe(results);
    });

    it('counts clauses, and the three counters PARTITION them', () => {
        const results = search('prazo recurso perícia');
        const text =
            'O prazo para recurso é de 15 dias corridos. ' +
            'Helicópteros sobrevoaram ilhas distantes.';
        const out = attributeLexical(text, results, { tokenizer });
        const { lexical, dense, unattributed } = out.rungs;
        // Asserted against the clause count the segmenter actually produces,
        // not against a number written from memory: the partition is the
        // invariant, and it holds however the text happens to split.
        expect(lexical + dense + unattributed).toBe(clausesOf(text, { tokenizer }).length);
        expect(dense).toBe(0); // no provider, no dense rung
        expect(unattributed).toBeGreaterThanOrEqual(1);
    });

    it('a figure the source lacks is vetoed and counted, and no chip is emitted', () => {
        const results = search('prazo recurso dias');
        const out = attributeLexical('O prazo para recurso é de 30 dias corridos.', results, {
            tokenizer,
        });
        expect(out.rungs.vetoed).toBe(1);
        expect(out.spans).toHaveLength(0);
        // `vetoed` never crosses `lexical`: the vetoed winner is not replaced
        // by the runner-up, it goes down a rung — and with no provider, out.
        expect(out.rungs.lexical).toBe(0);
        expect(out.rungs.unattributed).toBe(1);
    });

    it('every offset it reports is a code point offset, past an astral character', () => {
        const results = search('prazo recurso dias');
        const text = '💡 O prazo para recurso é de 15 dias corridos.';
        const out = attributeLexical(text, results, { tokenizer });
        const span = out.spans[0]!;
        // Read back with code points, which is what the contract says.
        const points = Array.from(text);
        expect(points.slice(span.textSpan.start, span.textSpan.end).join('')).toBe(text);
        // And the naive guard: only safe to index this string directly when
        // the two measures agree, which here they do not.
        expect(text.length).not.toBe(countCodePoints(text));
    });

    it('anchors the marker BEFORE the trailing punctuation, in the engine itself', () => {
        // The test the suite did not have, and its absence was the expensive
        // part: every other assertion about `anchorOffset` is over a `Placed`
        // built by hand, so a change to the marker convention passed with the
        // whole suite green. This one reads the number the engine produced.
        const results = search('prazo recurso dias');
        const text = '💡 O prazo para recurso é de 15 dias corridos.';
        const out = attributeLexical(text, results, { tokenizer });
        const span = out.spans[0]!;
        const points = Array.from(text);

        // Absolute, not relative to `textSpan.end`: asserting the difference
        // would hold just as well if both moved together, which is the failure
        // this is here to catch.
        expect(span.anchorOffset).toBe(points.length - 1);
        expect(points[span.anchorOffset]).toBe('.');
        expect(points[span.anchorOffset - 1]).toBe('s');
        // And the clause still ends where it ended: the anchor receded, the
        // span did not. In engine coordinates those are different things.
        expect(span.textSpan.end).toBe(points.length);
    });

    it('zero turns the floor off and puts an anchor on every supported clause', () => {
        const results = search('prazo recurso contagem dia');
        const text = 'O prazo é de 15 dias. A contagem exclui o dia inicial.';
        const grouped = attributeLexical(text, results, { tokenizer });
        const audited = attributeLexical(text, results, { tokenizer, minClusterCodePoints: 0 });
        expect(audited.spans.length).toBeGreaterThanOrEqual(grouped.spans.length);
    });
});
