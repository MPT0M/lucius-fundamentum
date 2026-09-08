import { describe, it, expect } from 'vitest';
import { parseResponse, viewOf, hintOf, resolveOrigin } from './parse.js';
import type { GoogleRawChunk, GoogleRawFixture, GoogleRawSupport } from './fixture.js';
import type { MaskedCorpus } from './corpus.js';
import { maskProtectedRegions } from '../../src/mask.js';

// ---------------------------------------------------------------------------
// The world: two documents in the round, one of them in the fixture.
//   A = 'aaaa bbbb $x$ cccc dddd'   B = 'zzzz yyyy'   derivedFrom = ['A']
// Chunks the emitter might return, by index:
//   0  text 'aaaa bbbb', title A, customMetadata documentId=A   → in fixture, both hints
//      (the metadata has an unrelated entry first)
//   1  no text (title A)                                        → discarded
//   2  text 'zzzz', title B                                     → outside the fixture, title only
//   3  text 'nowhere', title B                                  → outside, and not in B either
//   4  text 'cccc dddd', no hints                               → origin unresolved, located in the view
// Parts of the answer:
//   0  'Frase um. Frase dois.'   ASCII: bytes = code points
//   1  'Parte dois.'
//   2  'ação x'                  a=0 ç=1-2 ã=3-4 o=5 ' '=6 x=7 (bytes); 6 code points
// ---------------------------------------------------------------------------

const A = 'aaaa bbbb $x$ cccc dddd';
const B = 'zzzz yyyy';

function round(): MaskedCorpus {
    return new Map([
        ['A', { text: A, regions: maskProtectedRegions(A).spans }],
        ['B', { text: B, regions: maskProtectedRegions(B).spans }],
    ]);
}

const CHUNKS: readonly GoogleRawChunk[] = [
    // The documentId entry is deliberately not the first: a lookup by key must find it.
    { retrievedContext: { text: 'aaaa bbbb', title: 'A', customMetadata: [{ key: 'other', stringValue: 'not-a-doc' }, { key: 'documentId', stringValue: 'A' }] } },
    { retrievedContext: { title: 'A' } },
    { retrievedContext: { text: 'zzzz', title: 'B' } },
    { retrievedContext: { text: 'nowhere', title: 'B' } },
    { retrievedContext: { text: 'cccc dddd' } },
];

function fixture(supports: readonly GoogleRawSupport[], parts = [{ text: 'Frase um. Frase dois.' }, { text: 'Parte dois.' }, { text: 'ação x' }]): GoogleRawFixture {
    return {
        id: 'fx-1',
        model: 'test-model',
        recordedAt: '2026-09-08',
        reportVersion: 'test',
        storeEmbeddingModel: 'test-embedding',
        storeChunking: { maxTokensPerChunk: 100, maxOverlapTokens: 10 },
        parts,
        usageMetadata: { toolUsePromptTokenCount: 1 },
        groundingMetadata: { groundingChunks: CHUNKS, groundingSupports: supports },
    };
}

const parse = (supports: readonly GoogleRawSupport[]) => parseResponse(fixture(supports), round(), ['A']);

// The span that opens the answer: protobuf drops the zero-valued fields.
const OPENING: GoogleRawSupport = { segment: { endIndex: 9, text: 'Frase um.' }, groundingChunkIndices: [0] };

describe('parseResponse — what an absent field means is decided per field', () => {
    it('a support without startIndex and without partIndex is the span that opens the answer, not a violation', () => {
        const r = parse([OPENING]);
        expect(r.violations).toEqual({ length: [], position: [], missingPart: [], missingField: [] });
        expect(r.candidates).toHaveLength(1);
        expect(r.candidates[0]).toMatchObject({ partIndex: 0, textSpan: { start: 0, end: 9 } });
    });

    it('an absent groundingChunkIndices is a marker with no source: rawChunkCount 0, sources empty', () => {
        const r = parse([{ segment: { endIndex: 9, text: 'Frase um.' } }]);
        expect(r.candidates[0]).toMatchObject({ rawChunkCount: 0, sources: [] });
        expect(r.violations.missingField).toEqual([]);
    });

    it('an absent endIndex is a missingField violation and produces no candidate', () => {
        const r = parse([{ segment: { text: 'Frase um.' }, groundingChunkIndices: [0] }]);
        expect(r.candidates).toEqual([]);
        expect(r.violations.missingField).toEqual([{ segment: 0, field: 'endIndex' }]);
    });

    it('an absent segment text is a missingField violation and produces no candidate', () => {
        const r = parse([{ segment: { endIndex: 9 }, groundingChunkIndices: [0] }]);
        expect(r.candidates).toEqual([]);
        expect(r.violations.missingField).toEqual([{ segment: 0, field: 'segment.text' }]);
    });

    it('a partIndex that names no Part is a missingPart violation and produces no candidate', () => {
        const r = parse([{ segment: { partIndex: 7, endIndex: 9, text: 'Frase um.' }, groundingChunkIndices: [0] }]);
        expect(r.candidates).toEqual([]);
        expect(r.violations.missingPart).toEqual([0]);
    });

    it('a present partIndex selects its Part, and offsets are read against that Part', () => {
        const r = parse([{ segment: { partIndex: 1, endIndex: 11, text: 'Parte dois.' }, groundingChunkIndices: [0] }]);
        expect(r.candidates[0]).toMatchObject({ partIndex: 1, textSpan: { start: 0, end: 11 } });
        expect(r.violations.position).toEqual([]);
    });
});

describe('parseResponse — the three assertions the ruler leans on', () => {
    it('(1) an end one byte too far is a length violation with delta +1 — the sign the endIndex hypothesis is decided by', () => {
        const r = parse([{ segment: { endIndex: 10, text: 'Frase um.' }, groundingChunkIndices: [0] }]);
        expect(r.violations.length).toEqual([{ segment: 0, lengthDelta: 1 }]);
        // The stretched slice reads 'Frase um. ' and is a position failure too.
        expect(r.violations.position).toEqual([0]);
        // The candidate is still produced; publishability is the aggregator's call.
        expect(r.candidates).toHaveLength(1);
    });

    it('(2) a span whose converted slice is not the segment text is a position violation', () => {
        // Same length as 'Frase um.' (9), shifted by one: the slice reads 'rase um. '.
        const r = parse([{ segment: { startIndex: 1, endIndex: 10, text: 'Frase um.' }, groundingChunkIndices: [0] }]);
        expect(r.violations.length).toEqual([]);
        expect(r.violations.position).toEqual([0]);
        expect(r.candidates).toHaveLength(1);
    });

    it('(2) an offset past the end of the Part is a position violation with no candidate, not a crash', () => {
        const r = parse([{ segment: { endIndex: 999, text: 'Frase um.' }, groundingChunkIndices: [0] }]);
        expect(r.violations.position).toEqual([0]);
        // The length check ran first and recorded the third cause the delta list mixes.
        expect(r.violations.length).toEqual([{ segment: 0, lengthDelta: 990 }]);
        expect(r.candidates).toEqual([]);
    });

    it('a byte inside a multi-byte character is snapped and counted on the edge it belongs to', () => {
        // Part 2 'ação x': byte 2 is inside ç, byte 5 opens 'o'. Only the start snaps.
        const startOnly = parse([{ segment: { partIndex: 2, startIndex: 2, endIndex: 5, text: 'çã' }, groundingChunkIndices: [0] }]);
        expect(startOnly.snappedStarts).toBe(1);
        expect(startOnly.snappedEnds).toBe(0);
        expect(startOnly.candidates[0]).toMatchObject({ textSpan: { start: 1, end: 3 } }); // ç..ã in code points
        // 'çã' is 4 bytes and the offsets span 3: a snapped edge is also a length failure, delta -1.
        expect(startOnly.violations.length).toEqual([{ segment: 0, lengthDelta: -1 }]);

        // Byte 1 opens ç, byte 4 is inside ã. Only the end snaps.
        const endOnly = parse([{ segment: { partIndex: 2, startIndex: 1, endIndex: 4, text: 'çã' }, groundingChunkIndices: [0] }]);
        expect(endOnly.snappedStarts).toBe(0);
        expect(endOnly.snappedEnds).toBe(1);
        expect(endOnly.candidates[0]).toMatchObject({ textSpan: { start: 1, end: 3 } });
        expect(endOnly.violations.length).toEqual([{ segment: 0, lengthDelta: -1 }]);
    });

    it('a clean response has no violations and no snaps', () => {
        const r = parse([OPENING, { segment: { startIndex: 10, endIndex: 21, text: 'Frase dois.' }, groundingChunkIndices: [4] }]);
        expect(r.violations).toEqual({ length: [], position: [], missingPart: [], missingField: [] });
        expect(r.snappedStarts + r.snappedEnds).toBe(0);
        expect(r.candidates.map((c) => c.textSpan)).toEqual([{ start: 0, end: 9 }, { start: 10, end: 21 }]);
    });
});

describe('parseResponse — sources: one per chunk index with text, origin resolved before locating', () => {
    it('a chunk without text is discarded, and rawChunkCount keeps what the emitter attached', () => {
        const r = parse([{ ...OPENING, groundingChunkIndices: [0, 1] }]);
        const c = r.candidates[0]!;
        expect(c.rawChunkCount).toBe(2);
        expect(c.sources).toHaveLength(1);
    });

    it("two chunks with text give two sources, in the emitter's order, with rawChunkCount 2", () => {
        const r = parse([{ ...OPENING, groundingChunkIndices: [0, 4] }]);
        const c = r.candidates[0]!;
        expect(c.rawChunkCount).toBe(2);
        expect(c.sources.map((s) => s.located)).toEqual([
            { kind: 'exact', documentId: 'A', span: { start: 0, end: 9 } },
            { kind: 'exact', documentId: 'A', span: { start: 14, end: 23 } },
        ]);
    });

    it('every index without text leaves the marker with no source', () => {
        const r = parse([{ ...OPENING, groundingChunkIndices: [1, 1] }]);
        expect(r.candidates[0]).toMatchObject({ rawChunkCount: 2, sources: [] });
    });

    it('an in-fixture chunk resolves by custom metadata first and is located in the view', () => {
        const r = parse([OPENING]);
        const s = r.candidates[0]!.sources[0]!;
        expect(s.origin).toEqual({ documentId: 'A', resolvedBy: 'customMetadata', inFixture: true });
        expect(s.located).toEqual({ kind: 'exact', documentId: 'A', span: { start: 0, end: 9 } });
    });

    it('a chunk from outside the fixture resolves by title, is marked inFixture false, and is located in ITS document', () => {
        const r = parse([{ ...OPENING, groundingChunkIndices: [2] }]);
        const s = r.candidates[0]!.sources[0]!;
        expect(s.origin).toEqual({ documentId: 'B', resolvedBy: 'title', inFixture: false });
        expect(s.located).toEqual({ kind: 'exact', documentId: 'B', span: { start: 0, end: 4 } });
    });

    it('a chunk from outside the fixture whose text is not in its document either is not_found with inFixture false', () => {
        const r = parse([{ ...OPENING, groundingChunkIndices: [3] }]);
        const s = r.candidates[0]!.sources[0]!;
        expect(s.origin).toEqual({ documentId: 'B', resolvedBy: 'title', inFixture: false });
        expect(s.located).toEqual({ kind: 'not_found', snippet: 'nowhere' });
    });

    it('a chunk with no hints has an unresolved origin and is still located in the view', () => {
        const r = parse([{ ...OPENING, groundingChunkIndices: [4] }]);
        const s = r.candidates[0]!.sources[0]!;
        expect(s.origin).toEqual({ documentId: null, resolvedBy: null, inFixture: false });
        expect(s.located).toEqual({ kind: 'exact', documentId: 'A', span: { start: 14, end: 23 } });
    });
});

describe('viewOf, hintOf, resolveOrigin — the helpers have their own contracts', () => {
    it("viewOf restricts the round to the fixture's documents and refuses an unknown id by name", () => {
        const v = viewOf(round(), ['A']);
        expect([...v.keys()]).toEqual(['A']);
        expect(() => viewOf(round(), ['A', 'Z'])).toThrow(/"Z"/);
    });

    it('hintOf reads the title and the documentId entry of the custom metadata, or null', () => {
        expect(hintOf(CHUNKS[0])).toEqual({ title: 'A', customDocumentId: 'A' });
        expect(hintOf(CHUNKS[2])).toEqual({ title: 'B', customDocumentId: null });
        expect(hintOf(CHUNKS[4])).toEqual({ title: null, customDocumentId: null });
        expect(hintOf(undefined)).toEqual({ title: null, customDocumentId: null });
    });

    it('resolveOrigin prefers custom metadata over the title, matches by identity, and reports which one resolved', () => {
        const r = round();
        const v = viewOf(r, ['A']);
        expect(resolveOrigin({ title: 'B', customDocumentId: 'A' }, r, v)).toEqual({ documentId: 'A', resolvedBy: 'customMetadata', inFixture: true });
        expect(resolveOrigin({ title: 'B', customDocumentId: null }, r, v)).toEqual({ documentId: 'B', resolvedBy: 'title', inFixture: false });
        expect(resolveOrigin({ title: 'not-a-doc', customDocumentId: 'also-not' }, r, v)).toEqual({ documentId: null, resolvedBy: null, inFixture: false });
    });
});
