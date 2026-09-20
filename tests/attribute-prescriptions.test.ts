/**
 * The tests the plan promised and the first pass did not write, plus the two
 * the reversals showed were missing.
 *
 * Every one of them was written against a named target: the rule it checks is
 * undone in place and the test is watched going red, because a test that is
 * green under both versions proves neither.
 */

import { describe, it, expect } from 'vitest';
import {
    attribute,
    attributeLexical,
    formatAttribution,
    createIndex,
    createTokenizer,
    normalizeUnicode,
    type EmbeddingProvider,
    type SourceDoc,
    type SearchResult,
} from '../src/index.js';
import { applyDensity, type Placed } from '../src/attribute.js';

const DOC: SourceDoc = {
    id: 'lei',
    text:
        'O prazo para recurso é de 15 dias corridos. ' +
        'A contagem exclui o dia inicial e inclui o do vencimento. ' +
        'O relator pode conceder efeito suspensivo ao agravo. ' +
        'A perícia contábil será custeada pela parte requerente. ' +
        'O prazo em dobro alcança 30 dias no caso de litisconsórcio.',
};

const tokenizer = createTokenizer();

function search(query: string, doc: SourceDoc = DOC): readonly SearchResult[] {
    const index = createIndex([doc], {
        tokenizer,
        chunkOptions: { maxChunkCodePoints: 80, maxOverlapCodePoints: 40 },
    });
    return index.searchLexical(query, { topK: 6 });
}

const unit = (v: number[]) => {
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
};

/** Vectors chosen rather than hashed, so a condition can be created on purpose. */
function scripted(rules: [string, number[]][], fallback: number[]): EmbeddingProvider {
    const vectorFor = (text: string) => {
        for (const [needle, vector] of rules) if (text.includes(needle)) return unit(vector);
        return unit(fallback);
    };
    return {
        id: 'scripted',
        dimensions: 3,
        maxInputCodePoints: 100000,
        async embedDocuments(texts) {
            return texts.map(vectorFor);
        },
        async embedQuery(text) {
            return vectorFor(text);
        },
    };
}

describe('rungs.vetoed counts CLAUSES, not veto events', () => {
    it('a clause rejected at two rungs still adds one', async () => {
        // TARGET OF THE REVERSAL: drop the `countedVeto` guard around
        // `prepared.vetoed += 1` in the re-pick loop and this reads 2.
        //
        // The clause states a figure the lexical winner lacks, so the veto
        // rejects it there; the scripted provider then makes ANOTHER passage
        // without the figure the nearest, so the veto rejects again; the third
        // carries the figure and is cited.
        // Measured: the search has to return the third passage, or the loop
        // never rejects twice and the test passes with and without the guard.
        const results = search('prazo recurso dias dobro contagem vencimento');
        expect(results.length).toBeGreaterThanOrEqual(3);
        const provider = scripted(
            [
                ['30 dias corridos', [1, 0, 0]], // the clause itself
                ['prazo para recurso', [1, 0, 0]], // vetoed lexically: has 15, not 30
                ['contagem exclui', [1, 0, 0]], // nearest of what is left, and has no 30
                ['em dobro', [0.5, 0.87, 0]], // far enough behind to clear the margin
            ],
            [-1, 1, 0],
        );
        const out = await attribute('O prazo para recurso é de 30 dias corridos.', results, {
            tokenizer,
            provider,
        });
        expect(out.rungs.vetoed).toBe(1);
        expect(out.rungs.lexical + out.rungs.dense + out.rungs.unattributed).toBe(1);
    });
});

describe('a fused span does not fuse again after the floor moves its anchor', () => {
    it('the no-chaining flag is the only thing stopping the second fusion', () => {
        // TARGET OF THE REVERSAL: delete `!a.fused && !b.fused` from
        // `coalescePass` and this goes red.
        //
        // Pass 1 fuses A+B. The floor then moves the fused span AND C, so both
        // carry `moved`, they are consecutive clauses of the same passage, and
        // they land inside the window — every other condition of the second
        // pass is satisfied, and the closed flag is what remains.
        const span = (clause: number, anchor: number): Placed => ({
            span: {
                textSpan: { start: anchor - 10, end: anchor },
                anchorOffset: anchor,
                sourceSpan: { start: 0, end: 10 },
                chunkId: 'c1',
                documentId: 'doc',
                confidence: 0.9,
                resolvedBy: 'lexical',
            },
            firstClause: clause,
            lastClause: clause,
            terms: new Set([`t${clause}`]),
            moved: false,
            fused: false,
            // TRUE, which is what the engine writes when a sentence matched —
            // the ordinary case. A fixture defaulting to the exceptional value
            // describes a world the engine does not produce.
            precise: true,
        });
        // Every number here was measured rather than reasoned. The first pass
        // fuses greedily left to right, so a pair placed at the start swallows
        // its neighbour and the flag never gets a say; and the floor never moves
        // the FIRST anchor, because it has nothing to measure against.
        //
        // So: span 0 leads and holds the anchor. Spans 1 and 2 are 30 apart and
        // fuse in the first pass. Span 3 is 270 away — far outside the window —
        // so the first pass leaves it alone. Then the floor defers the fused
        // span AND span 3, landing them 40 apart: same passage, consecutive
        // clauses, both `moved`, inside the window. Every condition of the
        // second pass holds except that one of them is already closed.
        const ends = [10, 100, 130, 600, 640];
        const out = applyDensity(
            [span(0, 10), span(1, 100), span(2, 130), span(3, 400)],
            ends,
            () => 0.5,
            { coalesceMaxCodePoints: 80, minClusterCodePoints: 200 },
        );
        // 0 alone, 1+2 fused, 3 alone. Without the flag the fused pair swallows
        // 3 in the second pass and this reads 2.
        expect(out).toHaveLength(3);
    });
});

describe('indexing and attributing reduce the same text to the same terms', () => {
    it('a clause written in NFD matches a document written in NFC', () => {
        // masterplan:2050 asks for this by name, and it is the only test that
        // would catch the attributor tokenizing differently from the index on
        // ç, ã and decomposed forms — which is the failure the injection of a
        // single tokenizer exists to prevent.
        const nfc = 'A coração da questão é a aferição do prazo.';
        const nfd = nfc.normalize('NFD');
        expect(nfd).not.toBe(nfc);
        expect(normalizeUnicode(nfd)).toBe(nfc);

        const doc: SourceDoc = { id: 'acentos', text: nfc };
        const results = search('coração questão aferição', doc);
        const out = attributeLexical(nfd, results, { tokenizer });
        expect(out.rungs.lexical).toBeGreaterThan(0);
        expect(out.spans[0]!.documentId).toBe('acentos');
    });
});

describe('two short final clauses of one passage', () => {
    it('keep two spans in the data and print one marker', async () => {
        // The plan calls this the case that is not a corner: the floor never
        // moves the last anchor, so any text ending in two short clauses lands
        // here. The engine must preserve both spans — each with its own
        // `sourceSpan` and `confidence` — and the formatter must print one.
        // The floor never moves the LAST anchor, so the second-to-last can be
        // deferred onto it and the two end up at the same offset. The density
        // pass leaves them as two spans — the second pass only looks at pairs
        // the floor moved, and one of these did not move — and the formatter is
        // what collapses the marker.
        const at = (clause: number, anchor: number, source: number): Placed => ({
            span: {
                textSpan: { start: anchor - 12, end: anchor },
                anchorOffset: anchor,
                sourceSpan: { start: source, end: source + 20 },
                chunkId: 'lei#0',
                documentId: 'lei',
                confidence: 0.4 + clause / 10,
                resolvedBy: 'lexical',
            },
            firstClause: clause,
            lastClause: clause,
            terms: new Set([`t${clause}`]),
            moved: false,
            fused: false,
            // TRUE, which is what the engine writes when a sentence matched —
            // the ordinary case. A fixture defaulting to the exceptional value
            // describes a world the engine does not produce.
            precise: true,
        });
        // Three clauses, and the arrangement was measured: the floor never moves
        // the FIRST anchor (nothing to measure against) and never moves the LAST
        // (nowhere to defer to). So the leading span holds, the middle one is
        // deferred onto the end of the last clause, and the last one is already
        // there — two spans at one offset, which the second pass leaves alone
        // because only one of them moved.
        const spans = applyDensity(
            [at(0, 50, 0), at(1, 100, 300), at(2, 160, 600)],
            [50, 100, 160],
            () => 0.5,
            { coalesceMaxCodePoints: 10, minClusterCodePoints: 200 },
        );
        expect(spans).toHaveLength(3);
        const atLast = spans.filter((s) => s.anchorOffset === 160);
        expect(atLast).toHaveLength(2);
        // Each clause keeps its own supporting sentence and its own measure.
        expect(new Set(atLast.map((s) => s.sourceSpan.start)).size).toBe(2);
        expect(new Set(atLast.map((s) => s.confidence)).size).toBe(2);

        const results = search('prazo recurso dias');
        const formatted = formatAttribution(
            { text: 'x'.repeat(300), spans, sources: results, rungs: { lexical: 3, vetoed: 0, dense: 0, unattributed: 0 } },
            { markerStyle: 'bracket' },
        );
        // Three spans, two of them sharing an anchor and a passage: two markers.
        expect(formatted.text.match(/\[\d+\]/g) ?? []).toHaveLength(2);
        expect(formatted.spans).toHaveLength(3);
    });
});

describe('an astral character inside the PASSAGE', () => {
    it('does not shift sourceSpan, which is the field the popover opens', () => {
        // Every existing astral fixture puts the emoji in the ANSWER. This puts
        // it in the source document, which is the side that becomes
        // `sourceSpan` — measured in UTF-16 units it would come back short.
        const doc: SourceDoc = {
            id: 'astral',
            text: '💡 O prazo para recurso é de 15 dias corridos. A perícia segue depois.',
        };
        const results = search('prazo recurso dias', doc);
        const out = attributeLexical('O prazo para recurso é de 15 dias corridos.', results, {
            tokenizer,
        });
        const span = out.spans[0]!;
        const points = Array.from(doc.text);
        expect(points.slice(span.sourceSpan.start, span.sourceSpan.end).join('')).toBe(
            '💡 O prazo para recurso é de 15 dias corridos.',
        );
    });
});

describe('the window guard names the item it was handed', () => {
    it('calls a clause a clause, not a chunk', async () => {
        const results = search('prazo recurso dias');
        const inner = scripted([], [1, 0, 0]);
        // Measured: the candidate chunks are 43 and 59 code points and the
        // clause below is 68, so a window of 65 admits every chunk and refuses
        // only the clause. With a narrower window the CHUNK fails first and the
        // message never speaks of a clause at all.
        const narrow: EmbeddingProvider = { ...inner, maxInputCodePoints: 65 };
        await expect(
            attribute('O prazo do relator corre em dobro sem exceção alguma nesta hipótese.', results, {
                tokenizer,
                provider: narrow,
            }),
        ).rejects.toThrow(/^clause \d+: \d+ code points, window of provider/);
    });
});
