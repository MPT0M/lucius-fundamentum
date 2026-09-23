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

    it('two sources at one anchor join with ", ", and the group opens with a space', () => {
        // Asserted on the WHOLE string, not with `toContain`. Two `toContain`
        // calls stay true if the separator is dropped or changed, which is how
        // a convention published in three places ends up measured in none.
        const sources = [result('doc#0', 'doc', 1), result('doc#1', 'doc', 2)];
        const out = formatAttribution(
            attribution('Uma frase.', [span(9, 'doc#0'), span(9, 'doc#1')], sources),
            { markerStyle: 'bracket' },
        );
        expect(out.text).toBe('Uma frase [1], [2].');
    });

    it('orders a group by the number shown, not by chunk identifier', () => {
        // `doc#a` sorts before `doc#b` as a string but is source 2, so an
        // identifier-ordered comparator emits `[2], [1]` here.
        const sources = [result('doc#b', 'doc', 1), result('doc#a', 'doc', 2)];
        const out = formatAttribution(
            attribution('Uma frase.', [span(9, 'doc#a'), span(9, 'doc#b')], sources),
            { markerStyle: 'bracket' },
        );
        expect(out.text).toBe('Uma frase [1], [2].');
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
        // The width is DERIVED from the output, not written out. A hand-written
        // `'[1]'.length` was correct only while a marker was exactly three code
        // points; the affix that now precedes it made the literal wrong, and
        // the `.find()` then returned undefined — a crash, not a failed
        // assertion, which is the worst way for a test to notice a change.
        // Measured from the original anchor (10) to the first closing bracket,
        // so it covers the affix as well as the marker. Pure ASCII here, so
        // slicing by units is safe; the astral case is a separate test.
        const width = out.text.slice(10, out.text.indexOf(']') + 1).length;
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
        //
        // This span is hand-built, so the anchor here is a fixture and not the
        // engine's opinion. That is the whole reason the previous expectation
        // was worthless: `'💡 Uma frase[1].'` passed both before and after the
        // marker convention changed, because 11 was picked to make it pass.
        // What the engine actually produces at this position is asserted in
        // tests/attribute-lexical-door.test.ts, against a real attribution.
        const out = formatAttribution(attribution(text, [span(11, 'doc#0')], sources), {
            markerStyle: 'bracket',
        });
        expect(out.text).toBe('💡 Uma frase [1].');
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

describe('formatAttribution — carry moves stretches of the answer through the markers', () => {
    // `Uma frase. Outra.` with one citation anchored before the first period:
    // the marker ` [1]`, four code points, goes in at 9, so P = 9 and w = 4.
    //
    //   clean:   U m a _ f r a s e . _ O u t r a .
    //            0 1 2 3 4 5 6 7 8 9 ...
    //   marked:  `Uma frase [1]. Outra.`
    const TEXT = 'Uma frase. Outra.';
    const P = 9;
    const at = (text: string, s: { start: number; end: number }) =>
        Array.from(text).slice(s.start, s.end).join('');
    const carry = <T extends { start: number; end: number; attach?: 'left' | 'right' }>(entries: T[]) => {
        const out = formatAttribution(attribution(TEXT, [span(P, 'doc#0')], [result('doc#0', 'doc', 1)]), {
            markerStyle: 'bracket',
            carry: entries,
        });
        // No entry may come back inverted, in any test here. This is the
        // defect a point would have under the two-end rule.
        for (const c of out.carried) expect(c.end).toBeGreaterThanOrEqual(c.start);
        return out;
    };

    it('the marked text is the one the offsets below are counted against', () => {
        expect(carry([]).text).toBe('Uma frase [1]. Outra.');
    });

    it('a stretch before the marker does not move', () => {
        const out = carry([{ start: 0, end: 3 }]);
        expect(at(out.text, out.carried[0]!)).toBe('Uma');
    });

    it('a stretch after the marker moves by its width', () => {
        const out = carry([{ start: 11, end: 16 }]);
        expect(out.carried[0]).toEqual({ start: 15, end: 20 });
        expect(at(out.text, out.carried[0]!)).toBe('Outra');
    });

    it('a stretch that crosses the marker comes back containing it', () => {
        const out = carry([{ start: 4, end: 10 }]);
        expect(at(out.text, out.carried[0]!)).toBe('frase [1].');
    });

    it('a stretch that ends where the marker goes ends before it', () => {
        const out = carry([{ start: 4, end: P }]);
        expect(at(out.text, out.carried[0]!)).toBe('frase');
    });

    it('a stretch that starts where the marker goes starts after it', () => {
        // THE CASE THAT NEEDS `<=` AT THE START. Moved by the rule `spans` use,
        // `<` at both ends, this stretch would start at 9 and come back as
        // ` [1].` — a bold run that begins at an anchor would swallow the
        // marker in front of it.
        const out = carry([{ start: P, end: 10 }]);
        expect(at(out.text, out.carried[0]!)).toBe('.');
    });

    it('a point lands on the side its attach names', () => {
        const out = carry([
            { start: P, end: P, attach: 'left' as const },
            { start: P, end: P, attach: 'right' as const },
        ]);
        expect(out.carried.map((c) => c.start)).toEqual([P, P + 4]);
        const marked = Array.from(out.text);
        expect(marked.slice(0, out.carried[0]!.start).join('')).toBe('Uma frase');
        expect(marked.slice(0, out.carried[1]!.start).join('')).toBe('Uma frase [1]');
    });

    it('entries that land on one point come back in the order they were given', () => {
        // Two delimiters removed from the same place are restored in the order
        // they had; `carried` is `carry` mapped, never re-sorted.
        const out = carry([
            { start: 0, end: 0, attach: 'right' as const, id: 'first' },
            { start: 0, end: 0, attach: 'right' as const, id: 'second' },
        ]);
        expect(out.carried.map((c) => c.id)).toEqual(['first', 'second']);
    });

    it('the payload travels untouched and only the offsets change', () => {
        const out = carry([{ start: 11, end: 16, kind: 'strong', level: 2 }]);
        expect(out.carried[0]).toEqual({ start: 15, end: 20, kind: 'strong', level: 2 });
    });

    it('with no markers written, nothing carried moves', () => {
        const entries = [{ start: 4, end: 10 }, { start: P, end: P, attach: 'right' as const }];
        const out = formatAttribution(attribution(TEXT, [span(P, 'doc#0')], [result('doc#0', 'doc', 1)]), {
            markerStyle: 'none',
            carry: entries,
        });
        expect(out.carried).toEqual(entries);
    });

    it('asking for nothing returns an empty carried list', () => {
        const out = formatAttribution(attribution(TEXT, [span(P, 'doc#0')], [result('doc#0', 'doc', 1)]));
        expect(out.carried).toEqual([]);
    });

    it('refuses a stretch that ends before it starts', () => {
        expect(() => carry([{ start: 5, end: 3 }])).toThrow(/ends before it starts/);
    });

    it('an astral character before the marker does not move a carried stretch by a unit', () => {
        // The package positions in code points and JavaScript indexes in UTF-16
        // units. `💡` is one code point and two units, so arithmetic written
        // against `.length` puts every offset here one short.
        const text = '💡 Uma frase. Outra.';
        const anchor = 11;
        const out = formatAttribution(
            attribution(text, [span(anchor, 'doc#0')], [result('doc#0', 'doc', 1)]),
            { markerStyle: 'bracket', carry: [{ start: 2, end: anchor }] },
        );
        expect(out.text).toBe('💡 Uma frase [1]. Outra.');
        expect(at(out.text, out.carried[0]!)).toBe('Uma frase');
    });

    it('refuses a point that does not say which side it attaches to', () => {
        // Either side would be a guess the caller could not see in the output.
        expect(() => carry([{ start: P, end: P }])).toThrow(/needs `attach`/);
    });
});
