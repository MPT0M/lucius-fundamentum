/**
 * Where a marker lands at the end of a clause, and what the reader sees.
 *
 * The table below IS the predicate's instrument. It was measured once by a
 * probe that did not outlive the session that ran it, and a number that
 * decides code cannot live in a script nobody can run again — so the rows are
 * the measurement now, and a wrong one fails here rather than shipping.
 *
 * The rendered cases go through `formatAttribution`, not through string
 * concatenation. A test that reimplements the insertion it means to observe
 * measures the test, and the convention it is checking lives half in this
 * helper and half in the formatter.
 */
import { describe, it, expect } from 'vitest';
import { recedeAnchor } from '../src/sentences.js';
import { formatAttribution } from '../src/format-attribution.js';
import type { Attribution, AttributionSpan } from '../src/attribute.js';
import type { SearchResult } from '../src/index-build.js';

function result(chunkId: string, rank: number): SearchResult {
    return {
        chunk: { id: chunkId, documentId: 'doc', text: 'texto', span: { start: 0, end: 5 } },
        score: 1 / rank,
        rank,
    };
}

function spanAt(anchorOffset: number, chunkId: string): AttributionSpan {
    return {
        textSpan: { start: 0, end: anchorOffset },
        anchorOffset,
        sourceSpan: { start: 0, end: 5 },
        chunkId,
        documentId: 'doc',
        confidence: 0.8,
        resolvedBy: 'lexical',
    };
}

/**
 * Renders one clause with the markers a real formatter writes, anchored where
 * `recedeAnchor` puts them. The anchor is DERIVED, never a number chosen to
 * make the expectation pass.
 */
function render(text: string, chunkIds: readonly string[]): string {
    const points = Array.from(text);
    const anchor = recedeAnchor(points, 0, points.length);
    const sources = chunkIds.map((id, i) => result(id, i + 1));
    const attribution: Attribution = {
        text,
        spans: chunkIds.map((id) => spanAt(anchor, id)),
        sources,
        rungs: { lexical: chunkIds.length, vetoed: 0, dense: 0, unattributed: 0 },
    };
    return formatAttribution(attribution, { markerStyle: 'bracket' }).text;
}

describe('recedeAnchor — the predicate, one row per code point', () => {
    const RECEDES = ['.', '。', '！', '？', '।', '؟', '"', "'", '”', '»', '«', '「', '」', '…'];
    const STAYS = [')', ']', '%', '、', ',', ';', ':', 'a', '5'];

    it.each(RECEDES)('recedes past %s', (char) => {
        const points = Array.from(`abc${char}`);
        expect(recedeAnchor(points, 0, points.length)).toBe(3);
    });

    it.each(STAYS)('does not recede past %s', (char) => {
        const points = Array.from(`abc${char}`);
        expect(recedeAnchor(points, 0, points.length)).toBe(points.length);
    });

    it('a parenthetical citation is left alone, because it is detachable', () => {
        // `\p{Pe}` is excluded on purpose: delete `(BRASIL, 1988)` and the
        // clause still stands, so a marker before it would attribute the
        // source to the aside rather than to the assertion.
        const points = Array.from('conforme o artigo 5º (BRASIL, 1988)');
        expect(recedeAnchor(points, 0, points.length)).toBe(points.length);
    });

    it('an all-punctuation clause anchors at its END, never before its text', () => {
        // Reaching the floor means there is nothing to sit in front of, and a
        // marker at `start` would precede everything it cites — the one
        // position with no reading. The fallback to `end` is the output the
        // package produced before the recede existed.
        for (const text of ['...', '?!', '"”', '。。']) {
            const points = Array.from(text);
            expect(recedeAnchor(points, 0, points.length)).toBe(points.length);
        }
    });

    it('floors at the clause start, not at zero, when the clause begins mid-text', () => {
        // The walk must not cross out of its own clause into the one before.
        const points = Array.from('Primeira frase. ...');
        expect(recedeAnchor(points, 16, points.length)).toBe(points.length);
    });
});

describe('the rendered convention, through formatAttribution', () => {
    it.each([
        ['O prazo é de quinze dias corridos.', 'O prazo é de quinze dias corridos [1].'],
        ['A norma diz: "o prazo é de quinze dias."', 'A norma diz: "o prazo é de quinze dias [1]."'],
        ['A norma diz: "o prazo é de quinze dias".', 'A norma diz: "o prazo é de quinze dias [1]".'],
        ['conforme o artigo 5º (BRASIL, 1988).', 'conforme o artigo 5º (BRASIL, 1988) [1].'],
        ['この規定は十五日です。', 'この規定は十五日です [1]。'],
        ['O prazo seria de quinze dias…', 'O prazo seria de quinze dias [1]…'],
        ['O prazo é de quinze dias corridos', 'O prazo é de quinze dias corridos [1]'],
        ["and the decision was the workers'.", "and the decision was the workers [1]'."],
        ['Qual é o prazo?', 'Qual é o prazo [1]?'],
    ])('renders %s', (input, expected) => {
        expect(render(input, ['doc#0'])).toBe(expected);
    });

    it('renders two sources as a group, with the separator inside the clause', () => {
        // The tenth line, and the one the others do not cover: it is the only
        // case that exercises the `, ` separator.
        expect(render('O prazo é de quinze dias corridos.', ['doc#0', 'doc#1'])).toBe(
            'O prazo é de quinze dias corridos [1], [2].',
        );
    });
});
