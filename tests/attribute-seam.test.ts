import { describe, it, expect } from 'vitest';
import { centrality, chooseChunkForSeam } from '../src/attribute.js';
import { chunk as cutIntoChunks, DEFAULT_CHUNK_OPTIONS } from '../src/chunker.js';
import { sentencesOf, defaultSegmenter } from '../src/sentences.js';
import type { Span } from '../src/types.js';

/** A chunk as the seam rule reads it: an id and where it sits. */
function at(id: string, start: number, end: number) {
    return { id, span: { start, end } as Span };
}

describe('centrality — distance to the nearer edge', () => {
    it('is zero for a sentence pinned to an edge', () => {
        expect(centrality({ start: 0, end: 10 }, { start: 0, end: 100 })).toBe(0);
        expect(centrality({ start: 90, end: 100 }, { start: 0, end: 100 })).toBe(0);
    });

    it('grows as the sentence moves away from both edges', () => {
        const chunkSpan = { start: 0, end: 100 };
        expect(centrality({ start: 40, end: 60 }, chunkSpan)).toBe(40);
        expect(centrality({ start: 10, end: 60 }, chunkSpan)).toBe(10);
    });
});

describe('chooseChunkForSeam — which chunk the citation names', () => {
    const sentence: Span = { start: 180, end: 200 };

    it('names the chunk where the sentence sits furthest from an edge', () => {
        // The seam: the sentence ends chunk A and opens chunk B.
        const a = at('doc#0', 0, 200);
        const b = at('doc#1', 180, 400);
        expect(chooseChunkForSeam(sentence, [a, b], a).id).toBe('doc#1');
    });

    it('PROOF BY REVERSAL: the lowest-offset rule names the other chunk', () => {
        // The rule this one replaced. If both produced the same answer the test
        // above would pass under either and prove nothing, so the alternative is
        // run here and shown to disagree.
        const a = at('doc#0', 0, 200);
        const b = at('doc#1', 180, 400);
        const byLowestOffset = [a, b]
            .filter((c) => c.span.start <= sentence.start && c.span.end >= sentence.end)
            .sort((x, y) => x.span.start - y.span.start)[0]!;
        expect(byLowestOffset.id).toBe('doc#0');
        expect(chooseChunkForSeam(sentence, [a, b], a).id).not.toBe(byLowestOffset.id);
    });

    it('on a true seam centrality TIES at zero, and the text after decides', () => {
        // The sentence ends chunk N and opens chunk N+1, so it is pinned to an
        // edge in both. Breaking this by the lower offset would name N — the
        // view with nothing after the cited line — which is the one the rule
        // exists to refuse.
        const n = at('doc#0', 0, 200);
        const nPlus = at('doc#1', 180, 400);
        expect(centrality(sentence, n.span)).toBe(0);
        expect(centrality(sentence, nPlus.span)).toBe(0);
        expect(chooseChunkForSeam(sentence, [n, nPlus], n).id).toBe('doc#1');
    });

    it('centrality still decides when the sentence is inside both chunks', () => {
        const a = at('doc#0', 100, 280); // before 80, after 80 -> 80
        const b = at('doc#1', 120, 300); // before 60, after 100 -> 60
        expect(centrality(sentence, a.span)).toBe(80);
        expect(centrality(sentence, b.span)).toBe(60);
        expect(chooseChunkForSeam(sentence, [a, b], b).id).toBe('doc#0');
    });

    it('with centrality and text-after both tied, the lower offset is total', () => {
        const a = at('doc#0', 100, 280); // before 80, after 80
        const b = at('doc#1', 90, 280); // before 90, after 80 -> min 80
        expect(centrality(sentence, a.span)).toBe(centrality(sentence, b.span));
        expect(a.span.end).toBe(b.span.end);
        expect(chooseChunkForSeam(sentence, [a, b], a).id).toBe('doc#1');
    });

    it('ignores a chunk that does not carry the whole sentence', () => {
        const partial = at('doc#9', 190, 400);
        const whole = at('doc#0', 0, 200);
        expect(chooseChunkForSeam(sentence, [partial, whole], whole).id).toBe('doc#0');
    });

    it('falls back to the winner when no candidate carries the sentence', () => {
        const winner = at('doc#7', 900, 1000);
        expect(chooseChunkForSeam(sentence, [at('doc#8', 500, 600)], winner).id).toBe('doc#7');
    });
});

describe('the seam is real: the chunker overlaps in whole sentences', () => {
    it('a sentence on the overlap lands in two chunks at the SAME document offsets', () => {
        const text =
            'A primeira frase abre o texto. A segunda frase continua o tema. ' +
            'A terceira frase fecha o parágrafo. A quarta frase inicia outro. ' +
            'A quinta frase encerra tudo.';
        const chunks = cutIntoChunks({ id: 'doc', title: 'Doc', text }, DEFAULT_CHUNK_OPTIONS);
        const small = cutIntoChunks(
            { id: 'doc', title: 'Doc', text },
            { maxChunkCodePoints: 70, maxOverlapCodePoints: 40 },
        );
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(small.length).toBeGreaterThan(1);

        // What this asserts: the chunker really does overlap in whole
        // sentences, so a sentence carried by two chunks is a configuration
        // that occurs rather than one this rule imagines.
        //
        // What it does NOT assert: that the sentence gets the same span from
        // either chunk. The sentences are measured ONCE over the whole
        // document here, so sameness is a property of the measurement, not a
        // result. Production segments `chunk.text`, where a protected region
        // crossing an edge masks differently on each side. What keeps the
        // seam from duplicating a citation is that one span carries one
        // `chunkId` — not this. What the rule above decides is what the reader
        // sees AROUND the citation, and how stable the identifier is between
        // runs.
        const sentences = sentencesOf(text, defaultSegmenter());
        const carriedTwice = sentences.filter(
            (s) => small.filter((c) => c.span.start <= s.start && c.span.end >= s.end).length > 1,
        );
        expect(carriedTwice.length).toBeGreaterThan(0);
    });
});
