import { describe, it, expect } from 'vitest';
import { formatAttribution } from '../src/format-attribution.js';
import type { Attribution, AttributionSpan } from '../src/attribute.js';
import type { SearchResult } from '../src/index-build.js';

/** A search result reduced to what the formatter reads. */
function result(chunkId: string, documentId: string, rank: number): SearchResult {
    return {
        chunk: {
            id: chunkId,
            documentId,
            text: `texto de ${chunkId}`,
            span: { start: 0, end: 10 },
        },
        score: 1 / rank,
        rank,
    };
}

function span(anchorOffset: number, chunkId: string, documentId = 'doc'): AttributionSpan {
    return {
        textSpan: { start: anchorOffset - 10, end: anchorOffset },
        anchorOffset,
        sourceSpan: { start: 100, end: 140 },
        chunkId,
        documentId,
        confidence: 0.8,
        resolvedBy: 'lexical',
    };
}

function attribution(text: string, spans: AttributionSpan[], sources: SearchResult[]): Attribution {
    return { text, spans, sources, rungs: { lexical: spans.length, vetoed: 0, dense: 0, unattributed: 0 } };
}

describe('formatAttribution — the number indexes the CHUNK', () => {
    it('numbers by position in sources, 1-based in the text and 0-based in the anchor', () => {
        const sources = [result('doc#0', 'doc', 1), result('doc#1', 'doc', 2)];
        const out = formatAttribution(
            attribution('Uma frase. Outra frase.', [span(10, 'doc#1')], sources),
        );
        expect(out.text).toContain('[2](#cite-1)');
    });

    it('two chunks of the SAME document get different numbers', () => {
        // Numbering by document would print the same number twice at the same
        // anchor, and the deduplication — keyed on the chunk — would not catch
        // it. The engine already decided a different chunk is a different
        // citation: a different popover opens.
        const sources = [result('doc#0', 'doc', 1), result('doc#1', 'doc', 2)];
        const out = formatAttribution(
            attribution('Uma frase.', [span(10, 'doc#0'), span(10, 'doc#1')], sources),
        );
        expect(out.text).toContain('[1](#cite-0)');
        expect(out.text).toContain('[2](#cite-1)');
    });
});

describe('formatAttribution — deduplication, and what it must NOT hide', () => {
    it('two spans of the same passage at the same anchor share ONE marker', () => {
        const sources = [result('doc#0', 'doc', 1)];
        const spans = [span(10, 'doc#0'), { ...span(10, 'doc#0'), textSpan: { start: 0, end: 5 } }];
        const out = formatAttribution(attribution('Uma frase.', spans, sources), {
            markerStyle: 'bracket',
        });
        expect(out.text.match(/\[1\]/g)).toHaveLength(1);
        // The data keeps both: two supported stretches, each with its own span.
        expect(out.spans).toHaveLength(2);
    });

    it('two spans of DIFFERENT passages at the same anchor stay two markers', () => {
        const sources = [result('doc#0', 'doc', 1), result('other#0', 'other', 2)];
        const out = formatAttribution(
            attribution('Uma frase.', [span(10, 'doc#0'), span(10, 'other#0', 'other')], sources),
            { markerStyle: 'bracket' },
        );
        expect(out.text).toContain('[1]');
        expect(out.text).toContain('[2]');
    });
});

describe('formatAttribution — reindexing counts INSERTIONS, never spans', () => {
    it('a later span shifts by ONE marker width when two spans share a marker', () => {
        // THE TARGET OF THE REVERSAL, named before the test was written: make
        // the shift add a marker width per SPAN instead of per INSERTION, and
        // the third span lands one width too far.
        const sources = [result('doc#0', 'doc', 1)];
        const shared = [span(10, 'doc#0'), { ...span(10, 'doc#0'), textSpan: { start: 0, end: 5 } }];
        const later = span(40, 'doc#0');
        const out = formatAttribution(
            attribution('Uma frase curta e depois outra frase mais.', [...shared, later], sources),
            { markerStyle: 'bracket' },
        );
        const width = '[1]'.length;
        const moved = out.spans.find((s) => s.textSpan.start === 30 + width)!;
        expect(moved).toBeDefined();
        expect(moved.anchorOffset).toBe(40 + width);
    });

    it('does NOT reindex sourceSpan, which measures another text entirely', () => {
        const sources = [result('doc#0', 'doc', 1)];
        const out = formatAttribution(
            attribution('Uma frase. Outra.', [span(10, 'doc#0'), span(17, 'doc#0')], sources),
            { markerStyle: 'bracket' },
        );
        // Nothing was inserted into the source document.
        for (const s of out.spans) expect(s.sourceSpan).toEqual({ start: 100, end: 140 });
    });

    it('works past an astral character, because the offsets are code points', () => {
        const sources = [result('doc#0', 'doc', 1)];
        const text = '💡 Uma frase.';
        // The anchor sits at 11: after `frase`, before the period. Measured in
        // UTF-16 units the same number would land one position earlier, inside
        // the word, because the emoji is two units and one code point.
        const out = formatAttribution(attribution(text, [span(11, 'doc#0')], sources), {
            markerStyle: 'bracket',
        });
        expect(out.text).toBe('💡 Uma frase[1].');
    });
});

// Named for one axis, not two: the bibliography axis was removed with the
// footer, and provenance now travels in `sources` and `spans` instead.
describe('formatAttribution — the marker axis, and what rides alongside it', () => {
    const sources = [result('doc#0', 'doc', 1), result('doc#1', 'doc', 2), result('doc#2', 'doc', 3)];
    const one = attribution('Uma frase.', [span(10, 'doc#1')], sources);

    it("'none' inserts nothing, so the text and the spans come back untouched", () => {
        const out = formatAttribution(one, { markerStyle: 'none' });
        expect(out.text).toBe('Uma frase.');
        expect(out.spans[0]!.textSpan).toEqual({ start: 0, end: 10 });
        expect(out.spans[0]!.anchorOffset).toBe(10);
    });

    it("'none' is the voice case: nothing is added to the text, provenance is in the data", () => {
        // What the removed footer used to provide, a caller now composes from
        // these two. The test asserts they are enough to do it.
        const out = formatAttribution(one, { markerStyle: 'none' });
        expect(out.text).toBe('Uma frase.');
        expect(out.spans.map((s) => s.chunkId)).toEqual(['doc#1']);
        expect(out.sources.findIndex((r) => r.chunk.id === 'doc#1')).toBe(1);
    });

    it('sources travel with the formatted output, so a number can be resolved', () => {
        const out = formatAttribution(one, { markerStyle: 'bracket' });
        expect(out.sources).toBe(sources);
    });
});
