import { describe, it, expect } from 'vitest';
import {
    attribute,
    attributeLexical,
    attributeStream,
    createIndex,
    createTokenizer,
    deterministicProvider,
    type AttributionSpan,
    type EmbeddingProvider,
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

describe('attributeStream — WHEN, never WHICH, against the lexical door', () => {
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
        // Nothing is retracted AGAINST THE LEXICAL DOOR: a marker already on
        // the page does not vanish, does not change number and does not move.
        // Against `attribute` over a provider it can move and can be fused
        // away; see CHANGELOG, "the floor is not mode-invariant".
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

    it('the dense rung runs, and on a LAST clause the floor cannot take a span back', async () => {
        // The second pass, with the dense rung ON — and the precondition is
        // asserted rather than assumed. MEASURED over `ANSWER`: `rungs.dense`
        // came back 0 under BOTH providers, because every clause of it resolves
        // lexically. So the "second pass" was the first pass with a provider
        // hanging off it, and the case it exists for — a dense span sitting
        // BETWEEN two lexical ones, where a fusion rule reading span neighbours
        // would differ between modes — never arose.
        //
        // What creates the case is the ANSWER, not the provider: the middle
        // clause below shares no rare term with any single passage. Measured,
        // `deterministicProvider` reaches the dense rung on it too; the scripted
        // provider is here so that WHICH passage wins does not depend on the
        // geometry of a hash (`lei#1` under one, `lei#2` under the other). The
        // assertion is what fails if the case stops arising.
        //
        // AND THE MECHANISM THIS GUARDS IS THE FLOOR, NOT FUSION. Fusion cannot
        // differ here whatever the modes do: it requires equal `chunkId` AND
        // both sides `'lexical'` (`attribute.ts:593-595`), so a dense span never
        // fuses and two spans of different chunks never fuse. `applyFloor` is
        // the one that reads the list in order, and it is blind to rung and to
        // chunk — a dense span entering between two lexical ones becomes the
        // `previousAnchor` of the later one, which the stream never saw.
        //
        // THIS FIXTURE DOES NOT PROVE THE GUARANTEE IT ASSERTS. It passes on a
        // geometry that hides the break: the affected span is the LAST clause,
        // and the floor gives way on the last clause by design. Measured with
        // one clause more, the same shapes give
        //
        //     attributeLexical      lei#0@43  lei#3@119  lei#4@237
        //     attribute + provider  lei#0@43  lei#2@119(dense)  lei#3@179 …
        //
        // and the stream had already shown `lei#3@119`. See CHANGELOG, "the
        // floor is not mode-invariant".
        const answer =
            'O prazo para recurso é de 15 dias corridos. ' +
            'O prazo do relator. ' +
            'A perícia contábil será custeada pela parte requerente.';
        const unit = (v: number[]) => {
            const n = Math.hypot(...v);
            return v.map((x) => x / n);
        };
        const provider: EmbeddingProvider = {
            id: 'scripted',
            dimensions: 3,
            maxInputCodePoints: 100000,
            async embedDocuments(texts) {
                return texts.map((t) =>
                    t.includes('prazo do relator') || t.includes('relator pode')
                        ? unit([1, 0, 0])
                        : unit([-1, 1, 0]),
                );
            },
            async embedQuery() {
                return unit([-1, 1, 0]);
            },
        };

        const { shown } = stream(answer, results, 6);
        const full = await attribute(answer, results, { tokenizer, provider });

        expect(full.rungs.dense).toBeGreaterThan(0);
        expect(shown.length).toBeGreaterThan(0);
        for (const span of shown) {
            expect(full.spans).toContainEqual(span);
        }
    });
});
