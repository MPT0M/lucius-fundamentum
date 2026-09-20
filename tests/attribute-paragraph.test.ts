/**
 * The collective granularity: one anchor per paragraph, carrying every source
 * used anywhere inside it.
 *
 * The blank-line measurement that justifies masking lives here as a test
 * rather than as a note: it is the whole argument for taking the mask, and a
 * number that decides code cannot live in a script nobody can run again.
 *
 * The recede predicate and its rendered cases are in
 * `tests/recede-anchor.test.ts`: they demonstrate the marker convention,
 * which is a different subject from this one.
 */
import { describe, it, expect } from 'vitest';
import { paragraphEndsOf, sentencesOf, defaultSegmenter } from '../src/sentences.js';
import { maskProtectedRegions } from '../src/mask.js';
import {
    createIndex,
    createTokenizer,
    attributeLexical,
    formatAttribution,
    DEFAULT_COALESCE_MAX_CODE_POINTS,
    type SourceDoc,
    type SearchResult,
} from '../src/index.js';

const DOC: SourceDoc = {
    id: 'lei',
    text:
        'O prazo para recurso é de quinze dias corridos. ' +
        'A contagem exclui o dia do começo e inclui o do vencimento. ' +
        'O relator pode conceder efeito suspensivo ao agravo. ' +
        'A perícia contábil será custeada pela parte requerente.',
};

const tokenizer = createTokenizer();

function search(query: string): readonly SearchResult[] {
    const index = createIndex([DOC], {
        tokenizer,
        chunkOptions: { maxChunkCodePoints: 70, maxOverlapCodePoints: 30 },
    });
    return index.searchLexical(query, { topK: 6 });
}

describe('paragraphEndsOf — the boundary is a blank line, and it is measured', () => {
    it('finds the boundary in CRLF as well as LF, which a literal \\n\\n would not', () => {
        const lf = 'Primeiro bloco.\n\nSegundo bloco.';
        const crlf = 'Primeiro bloco.\r\n\r\nSegundo bloco.';
        // The failure mode this guards is silent: zero boundaries is not an
        // error, it is one marker for the whole answer.
        expect(paragraphEndsOf(lf)).toHaveLength(2);
        expect(paragraphEndsOf(crlf)).toHaveLength(2);
    });

    it('tolerates horizontal whitespace on the blank line', () => {
        expect(paragraphEndsOf('Um.\n   \nDois.')).toHaveLength(2);
        expect(paragraphEndsOf('Um.\n\t\nDois.')).toHaveLength(2);
    });

    it('a blank line inside a fenced block does NOT fabricate a boundary', () => {
        // This is the measurement the design rests on, kept as a test because
        // it is what justifies masking at all. Three blank lines in the raw
        // text, one of them inside the fence; two boundaries survive masking,
        // and the offsets stay valid because the mask preserves length.
        const text = [
            'Antes do bloco.',
            '',
            '```python',
            'a = 1',
            '',
            'b = 2',
            '```',
            '',
            'Depois do bloco.',
        ].join('\n');

        const blankLines = (s: string): number[] =>
            [...s.matchAll(/\n[^\S\r\n]*\n/gu)].map((m) => m.index);

        // POSITIONS, not just counts: a count survives a mask that moved a
        // boundary instead of removing one, and the whole argument for masking
        // is that the surviving boundaries are the same ones.
        expect(blankLines(text)).toEqual([15, 32, 43]);
        expect(blankLines(maskProtectedRegions(text).text)).toEqual([15, 43]);
        // Length preserved, which is why the offsets are valid on the original.
        expect(maskProtectedRegions(text).text.length).toBe(text.length);

        // Two boundaries plus the end of the text.
        expect(paragraphEndsOf(text)).toHaveLength(3);
        expect(paragraphEndsOf(text).at(-1)).toBe(Array.from(text).length);
    });

    it('no clause can straddle a boundary, so the tie-break is unreachable', () => {
        // The design document asked for the invariant "every paragraph end has
        // a clause ending at or before it, and the next starts after it" to be
        // turned into an assertion, with the tie-break written for the case of
        // a clause crossing a boundary.
        //
        // The tie-break is written (a clause belongs to the block its START
        // falls in) and it is UNREACHABLE: the segmenter breaks on a blank
        // line even when the text before it has no sentence terminal at all,
        // because a paragraph separator is a mandatory break. So the invariant
        // holds by the segmenter's behaviour rather than by our rule.
        //
        // This is a test rather than a runtime assertion on purpose: a pure
        // function that throws on a text the caller legitimately produced
        // trades graceful degradation for a crash.
        const text = ['Primeiro pedaço sem ponto', '', 'segundo pedaço.'].join('\n');
        const clauses = sentencesOf(text, defaultSegmenter());
        const ends = paragraphEndsOf(text);

        expect(clauses).toHaveLength(2);
        for (const end of ends) {
            // No clause opens before a boundary and closes after it.
            expect(clauses.filter((c) => c.start < end && c.end > end)).toHaveLength(0);
        }
        // And the first clause really does stop AT the boundary, with no
        // terminal punctuation to have stopped it.
        expect(clauses[0]!.end).toBe(ends[0]);
        expect(Array.from(text)[clauses[0]!.end - 1]).toBe('o');
    });

    it('the last paragraph ends at the end of the text, blank line or not', () => {
        expect(paragraphEndsOf('Sem quebra nenhuma.').at(-1)).toBe(19);
        expect(paragraphEndsOf('Um.\n\nDois.').at(-1)).toBe(10);
    });
});

describe("granularity: 'paragraph' — one anchor per block", () => {
    const ANSWER =
        'O prazo para recurso é de quinze dias corridos. ' +
        'A contagem exclui o dia do começo.\n\n' +
        'O relator pode conceder efeito suspensivo ao agravo.';

    it('puts every marker of a block at the same offset, one per block', () => {
        const results = search('prazo recurso contagem relator suspensivo');
        const out = attributeLexical(ANSWER, results, { tokenizer, granularity: 'paragraph' });
        const offsets = [...new Set(out.spans.map((s) => s.anchorOffset))].sort((a, b) => a - b);
        const points = Array.from(ANSWER);
        const boundary = points.findIndex((c) => c === '\n');

        expect(out.spans.length).toBeGreaterThan(0);
        // Exactly one anchor per block, not "at most": an upper bound is also
        // satisfied by a mode that emits nothing at all.
        //
        // **This does NOT discriminate the modes, and that is fine.** Swapping
        // 'paragraph' for 'cluster' above leaves it green - measured, not
        // assumed - because on this fixture 'cluster' happens to land one
        // anchor on each side too. What it pins is an invariant worth pinning
        // on its own: no block comes out without an anchor. The tests that
        // separate the modes are the two below.
        expect(offsets).toHaveLength(2);
        expect(offsets.filter((o) => o < boundary)).toHaveLength(1);
        expect(offsets.filter((o) => o > boundary)).toHaveLength(1);
    });

    it('anchors at the receded end of the last clause, not at the boundary', () => {
        const results = search('prazo recurso contagem');
        const out = attributeLexical(ANSWER, results, { tokenizer, granularity: 'paragraph' });
        const points = Array.from(ANSWER);
        for (const span of out.spans) {
            // Never on a newline: anchoring at the boundary would render
            // `"...começo. [1]\n\n"`, the convention this package just left.
            expect(points[span.anchorOffset]).not.toBe('\n');
        }
    });

    it("moves the block's anchor to its last clause, where 'cluster' leaves it mid-block", () => {
        const results = search('prazo recurso contagem relator suspensivo');
        const offsets = (granularity: 'cluster' | 'paragraph'): number[] => {
            const out = attributeLexical(ANSWER, results, { tokenizer, granularity });
            return [...new Set(out.spans.map((s) => s.anchorOffset))].sort((x, y) => x - y);
        };

        // Counting anchors does NOT separate the modes on this input, and that
        // is worth knowing rather than working around: coalescence already
        // fused the first block's two clauses in 'cluster', so both modes emit
        // two. What differs is WHERE the first one sits.
        expect(offsets('cluster')).toHaveLength(2);
        expect(offsets('paragraph')).toHaveLength(2);

        const points = Array.from(ANSWER);
        const [conjunctive] = offsets('cluster');
        const [collective] = offsets('paragraph');
        // Conjunctive: the end of the FIRST sentence of the block.
        expect(points[conjunctive!]).toBe('.');
        expect(points.slice(conjunctive! - 8, conjunctive!).join('')).toBe('corridos');
        // Collective: the end of the LAST sentence of the block.
        expect(points[collective!]).toBe('.');
        expect(points.slice(collective! - 6, collective!).join('')).toBe('começo');
        expect(collective!).toBeGreaterThan(conjunctive!);
    });

    it('renders each block with exactly one marker, before its closing period', () => {
        const results = search('prazo recurso contagem relator suspensivo');
        const rendered = (granularity: 'cluster' | 'paragraph'): string =>
            formatAttribution(attributeLexical(ANSWER, results, { tokenizer, granularity }), {
                markerStyle: 'bracket',
            }).text;

        const collective = rendered('paragraph');
        // One GROUP per block, not one marker: the mode promises one anchor
        // carrying every source used anywhere in the block, so a block citing
        // two passages renders `[2], [3]` together. What must not happen is
        // markers scattered through the block, which is what 'cluster' does.
        // The earlier version asserted only that nothing was glued to a
        // period, which 'cluster' also satisfies.
        for (const block of collective.split('\n\n')) {
            const group = block.match(/\[\d+\](?:, \[\d+\])*/gu);
            expect(group).toHaveLength(1);
        }
        expect(collective).toMatch(/começo \[\d+\](?:, \[\d+\])*\./u);
        // And it really is a different rendering from the default mode.
        expect(collective).not.toBe(rendered('cluster'));
    });

    it('a clause pair across a blank line keeps the first block marker', () => {
        // Regression. Before the fusion gate, two clauses of the SAME passage
        // on either side of a blank line fused: the merged span took the LATER
        // anchor, its textSpan swallowed the boundary, and the first paragraph
        // came out with no marker at all. Measured then: one span, anchor 53,
        // textSpan {0, 54}, and the first block rendered bare.
        const doc: SourceDoc = {
            id: 'lei',
            text: 'O prazo para recurso é de quinze dias corridos e a contagem exclui o dia do começo.',
        };
        const index = createIndex([doc], {
            tokenizer,
            chunkOptions: { maxChunkCodePoints: 200, maxOverlapCodePoints: 0 },
        });
        const results = index.searchLexical('prazo quinze dias contagem começo', { topK: 6 });
        const answer = ['O prazo é de quinze dias.', '', 'A contagem exclui o começo.'].join('\n');

        const out = attributeLexical(answer, results, { tokenizer, granularity: 'paragraph' });
        const points = Array.from(answer);
        const anchors = [...new Set(out.spans.map((s) => s.anchorOffset))].sort((a, b) => a - b);

        // Both blocks are attributed to the same passage, and both keep a marker.
        expect(new Set(out.spans.map((s) => s.chunkId)).size).toBe(1);
        expect(anchors).toHaveLength(2);
        // The fixture has to stay INSIDE the fusion window, or this passes for
        // the wrong reason: two blocks far enough apart never qualified to
        // fuse, gate or no gate, and the regression would go unguarded in
        // silence.
        expect(anchors[1]! - anchors[0]!).toBeLessThan(DEFAULT_COALESCE_MAX_CODE_POINTS);
        // Neither span crosses the blank line.
        const boundary = points.findIndex((c) => c === '\n');
        for (const span of out.spans) {
            const opensInFirstBlock = span.textSpan.start < boundary;
            expect(opensInFirstBlock).toBe(span.textSpan.end <= boundary);
        }
        expect(formatAttribution(out, { markerStyle: 'bracket' }).text).toContain(
            'O prazo é de quinze dias [1].',
        );
    });

    it('minClusterCodePoints is ignored in this mode: 0 and 70 give the same spans', () => {
        // The inertia the design document asked to be proved rather than
        // asserted in prose. The floor is switched off because every anchor in
        // a block is the same offset, so it would fire on all of them.
        const results = search('prazo recurso contagem relator suspensivo');
        const off = attributeLexical(ANSWER, results, {
            tokenizer,
            granularity: 'paragraph',
            minClusterCodePoints: 0,
        });
        const on = attributeLexical(ANSWER, results, {
            tokenizer,
            granularity: 'paragraph',
            minClusterCodePoints: 70,
        });
        expect(off.spans).toEqual(on.spans);
        // The control, RUN rather than announced: the same pair of values
        // changes the default mode, so the equality above is the mode's doing
        // and not a fixture that no floor would ever touch.
        const clusterOff = attributeLexical(ANSWER, results, {
            tokenizer,
            granularity: 'cluster',
            minClusterCodePoints: 0,
        });
        const clusterOn = attributeLexical(ANSWER, results, {
            tokenizer,
            granularity: 'cluster',
            minClusterCodePoints: 70,
        });
        expect(clusterOff.spans).not.toEqual(clusterOn.spans);
    });

    it('coalesceMaxCodePoints is ignored too: 0 and 500 give the same spans', () => {
        // The twin of the test above, and it replaces one that asserted the
        // OPPOSITE with `toBeLessThanOrEqual` — an operator satisfied by
        // equality, which is exactly the inert case. The test written to prove
        // "not inert" passed precisely when it was inert.
        //
        // Both options end up ignored, and by the same fact: inside a block
        // every anchor is the same offset, so the fusion distance is always
        // zero and any window accepts it; between blocks the gate refuses
        // before the distance is consulted.
        const results = search('prazo recurso contagem relator suspensivo');
        const narrow = attributeLexical(ANSWER, results, {
            tokenizer,
            granularity: 'paragraph',
            coalesceMaxCodePoints: 0,
        });
        const wide = attributeLexical(ANSWER, results, {
            tokenizer,
            granularity: 'paragraph',
            coalesceMaxCodePoints: 500,
        });
        expect(narrow.spans).toEqual(wide.spans);
        expect(narrow.spans.length).toBeGreaterThan(0);
    });
});
