import { describe, it, expect } from 'vitest';
import {
    attribute,
    attributeLexical,
    attributeStream,
    createIndex,
    createTokenizer,
    deterministicProvider,
    type AttributionSpan,
    type SourceDoc,
    type SearchResult,
} from '../src/index.js';

const DOC: SourceDoc = {
    id: 'lei',
    title: 'Lei',
    text:
        'O prazo para recurso é de 15 dias corridos. ' +
        'A contagem exclui o dia inicial e inclui o do vencimento. ' +
        'O relator pode conceder efeito suspensivo ao agravo. ' +
        'A perícia contábil será custeada pela parte requerente.',
};

const tokenizer = createTokenizer();

function search(query: string): readonly SearchResult[] {
    const index = createIndex([DOC], {
        tokenizer,
        chunkOptions: { maxChunkCodePoints: 80, maxOverlapCodePoints: 40 },
    });
    return index.searchLexical(query, { topK: 6 });
}

/** Feeds a text through the stream in chunks of `size` code points. */
function stream(text: string, results: readonly SearchResult[], size: number, opts = {}) {
    const handle = attributeStream(results, { tokenizer, ...opts });
    const shown: AttributionSpan[] = [];
    const points = Array.from(text);
    for (let i = 0; i < points.length; i += size) {
        shown.push(...handle.push(points.slice(i, i + size).join('')));
    }
    return { shown, envelope: handle.end() };
}

const ANSWER =
    'O prazo para recurso é de 15 dias corridos. ' +
    'A contagem exclui o dia inicial. ' +
    'O relator concede efeito suspensivo ao agravo. ' +
    'A perícia será custeada pela parte requerente.';

describe('attributeStream — the mode chooses WHEN, never WHICH', () => {
    const results = search('prazo contagem relator perícia');

    it('the envelope matches the batch door exactly, whatever the delta size', () => {
        const batch = attributeLexical(ANSWER, results, { tokenizer });
        for (const size of [1, 3, 7, 40, 500]) {
            const { envelope } = stream(ANSWER, results, size);
            expect(envelope.spans).toEqual(batch.spans);
            expect(envelope.text).toBe(batch.text);
            expect(envelope.sources).toBe(results);
        }
    });

    it('what was shown while writing is a PREFIX of what the envelope holds', () => {
        // Nothing is retracted: a marker already on the page does not vanish,
        // does not change number and does not move.
        for (const size of [1, 5, 23]) {
            const { shown, envelope } = stream(ANSWER, results, size);
            expect(envelope.spans.slice(0, shown.length)).toEqual(shown);
        }
    });

    it('survives deltas cut mid-word, mid-number and mid-formula', () => {
        // A model emits `A educa` and then `ção`. Feeding one code point at a
        // time is the harshest version of that, and the figures and the formula
        // are the places where a naive buffer would split a token.
        const tricky =
            'O artigo 8.078/90 entrou em vigor em 1990. ' +
            'A identidade $x = 1.$ vale sempre. ' +
            'O prazo é de 15 dias corridos.';
        const batch = attributeLexical(tricky, results, { tokenizer });
        const { envelope, shown } = stream(tricky, results, 1);
        expect(envelope.spans).toEqual(batch.spans);
        expect(envelope.spans.slice(0, shown.length)).toEqual(shown);
    });

    it('attributes a final clause with no terminator', () => {
        // The model was cut mid-sentence. The batch door attributes that
        // fragment, so dropping it here would make the stream answer LESS than
        // `attribute` over the same text.
        const cut = 'O prazo para recurso é de 15 dias corridos. A contagem exclui o dia inicial';
        const batch = attributeLexical(cut, results, { tokenizer });
        const { envelope } = stream(cut, results, 4);
        expect(envelope.spans).toEqual(batch.spans);
        expect(envelope.spans.length).toBeGreaterThan(0);
    });

    it('holds the invariant with the floor ABOVE the fusion window', () => {
        // The configuration where the floor defers an anchor past the window,
        // which is where the second pass acts.
        //
        // WHAT THIS DOES NOT PROVE: measured, it passes with a lookahead of one
        // as well. The bound of TWO is derived from the design — coalescence
        // needs the neighbour, and the floor can defer that neighbour one
        // clause further — and no fixture here distinguishes the two values.
        // A lookahead of ZERO does break it, so the window is load-bearing;
        // its exact size is argued, not measured. Declared in the debts.
        const opts = { minClusterCodePoints: 200, coalesceMaxCodePoints: 80 };
        const batch = attributeLexical(ANSWER, results, { tokenizer, ...opts });
        for (const size of [1, 4, 17]) {
            const { shown, envelope } = stream(ANSWER, results, size, opts);
            expect(envelope.spans).toEqual(batch.spans);
            expect(envelope.spans.slice(0, shown.length)).toEqual(shown);
        }
    });

    it('holds a span back until two clauses have closed after it', () => {
        const handle = attributeStream(results, { tokenizer });
        // One clause closed: nothing can be final yet, whatever it scored.
        const first = handle.push('O prazo para recurso é de 15 dias corridos. ');
        expect(first).toHaveLength(0);
    });
});

describe('attributeStream — what it does NOT promise', () => {
    const results = search('prazo contagem relator perícia');

    it('ignores a provider instead of quietly going to the network', async () => {
        let calls = 0;
        const inner = deterministicProvider(16);
        const provider = {
            ...inner,
            async embedDocuments(texts: readonly string[]) {
                calls += 1;
                return inner.embedDocuments(texts);
            },
        };
        const { envelope } = stream(ANSWER, results, 9, { provider });
        expect(calls).toBe(0);
        expect(envelope.rungs.dense).toBe(0);
    });

    it('the counters are MODE-DEPENDENT, and the invariant does not cover them', async () => {
        // `rungs.dense` is always zero here by construction, and clauses the
        // vectors would have decided land in `unattributed`. Comparing the
        // counters across modes is comparing different instruments — the
        // invariant is about `spans` and `sources`.
        const { envelope } = stream(ANSWER, results, 11);
        const full = await attribute(ANSWER, results, {
            tokenizer,
            provider: deterministicProvider(16),
        });
        expect(envelope.rungs.dense).toBe(0);
        expect(envelope.spans.length).toBeLessThanOrEqual(full.spans.length);
    });

    it('a span the stream showed is still present once the dense rung has run', async () => {
        // The second pass, with the dense rung ON. The first pass turns it off
        // on both sides, and with it off the case where a dense span sits
        // between two lexical ones cannot arise at all — the blind spot of the
        // fixture rather than of the rule.
        const { shown } = stream(ANSWER, results, 6);
        const full = await attribute(ANSWER, results, {
            tokenizer,
            provider: deterministicProvider(16),
        });
        for (const span of shown) {
            expect(full.spans).toContainEqual(span);
        }
    });
});
