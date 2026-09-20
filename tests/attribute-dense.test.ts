import { describe, it, expect } from 'vitest';
import {
    attribute,
    attributeLexical,
    createIndex,
    createTokenizer,
    deterministicProvider,
    type EmbeddingProvider,
    type SourceDoc,
    type SearchResult,
} from '../src/index.js';

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

function search(query: string): readonly SearchResult[] {
    const index = createIndex([DOC], {
        tokenizer,
        chunkOptions: { maxChunkCodePoints: 80, maxOverlapCodePoints: 40 },
    });
    return index.searchLexical(query, { topK: 6 });
}

/** Wraps a provider and counts how many times the network would be reached. */
function counting(inner: EmbeddingProvider) {
    let calls = 0;
    const provider: EmbeddingProvider = {
        ...inner,
        async embedDocuments(texts) {
            calls += 1;
            return inner.embedDocuments(texts);
        },
        async embedQuery(text) {
            calls += 1;
            return inner.embedQuery(text);
        },
    };
    return { provider, calls: () => calls };
}


/**
 * A provider whose vectors are chosen, not hashed.
 *
 * The deterministic provider cannot create the two conditions below — a vetoed
 * passage that is ALSO the nearest by cosine, and a passage pointing away — and
 * a test written with it passes with and without the rules it claims to check.
 * Both reversals were run and both stayed green before this was written.
 */
function scripted(): EmbeddingProvider {
    const unit = (v: number[]) => {
        const n = Math.hypot(...v);
        return v.map((x) => x / n);
    };
    const vectorFor = (text: string): number[] => {
        if (text.includes('30 dias')) return unit([1, 0, 0]); // the clause of the veto test
        if (text.includes('decorre')) return unit([1, 0, 0]); // the clause of the sign test
        if (text.includes('prazo para recurso')) return unit([1, 0, 0]); // cos 1: the vetoed one
        if (text.includes('em dobro')) return unit([4, 1, 0]); // cos ~0.97: the runner-up
        return unit([-1, 1, 0]); // cos about -0.71: pointing away
    };
    return {
        id: 'scripted',
        dimensions: 3,
        maxInputCodePoints: 100000,
        async embedDocuments(texts) {
            return texts.map((t) => vectorFor(t));
        },
        async embedQuery(text) {
            return vectorFor(text);
        },
    };
}

describe('attribute — the ladder, and what its last rung costs', () => {
    it('without a provider it answers exactly what the lexical door answers', async () => {
        const results = search('prazo recurso dias');
        const text = 'O prazo para recurso é de 15 dias corridos.';
        const withProvider = await attribute(text, results, { tokenizer });
        expect(withProvider).toEqual(attributeLexical(text, results, { tokenizer }));
    });

    it('pays NOTHING when no clause is ambiguous', async () => {
        const { provider, calls } = counting(deterministicProvider(16));
        const results = search('prazo recurso dias');
        await attribute('O prazo para recurso é de 15 dias corridos.', results, {
            tokenizer,
            provider,
        });
        expect(calls()).toBe(0);
    });

    it('pays TWO calls however many clauses are ambiguous', async () => {
        const { provider, calls } = counting(deterministicProvider(16));
        const results = search('prazo contagem relator perícia');
        // Several clauses the words cannot separate, in one answer.
        const text =
            'Isso vale em regra. Também se aplica aqui. O mesmo ocorre adiante. ' +
            'Vale igualmente no caso seguinte.';
        await attribute(text, results, { tokenizer, provider });
        // Not one per clause: the cost that made the ladder necessary would be
        // back if the last rung charged per sentence.
        expect(calls()).toBe(2);
    });

    it('never goes through the query door, on either side', async () => {
        let queryCalls = 0;
        const inner = deterministicProvider(16);
        const provider: EmbeddingProvider = {
            ...inner,
            async embedQuery(text) {
                queryCalls += 1;
                return inner.embedQuery(text);
            },
        };
        const results = search('prazo contagem relator');
        await attribute('Isso vale em regra. Também se aplica aqui.', results, {
            tokenizer,
            provider,
        });
        // A clause is declarative text compared against declarative text. The
        // query door carries a different task prefix on some providers, and the
        // cosine would measure the prefix.
        expect(queryCalls).toBe(0);
    });

    it('refuses a clause the provider window cannot hold, before paying', async () => {
        const inner = deterministicProvider(16);
        const narrow: EmbeddingProvider = { ...inner, maxInputCodePoints: 20 };
        const results = search('prazo contagem relator');
        await expect(
            attribute('Isso vale em regra e também adiante, sem exceção alguma.', results, {
                tokenizer,
                provider: narrow,
            }),
        ).rejects.toThrow(/code points, window of provider/);
    });

    it('does not re-elect a candidate the veto rejected', async () => {
        // The figure the answer states is absent from the passage the words
        // pick, so the veto rejects it. The scripted provider then makes that
        // same passage the CLEAR nearest by cosine — which is the realistic
        // case, since the lexical winner usually is — so a rung that did not
        // know it was rejected would cite it and the veto would be decoration.
        //
        // TARGET OF THE REVERSAL, named before the test was written: delete
        // `if (ineligible.has(index)) return;` in `denseRung` and this goes red.
        const results = search('prazo recurso dias');
        const out = await attribute('O prazo para recurso é de 30 dias corridos.', results, {
            tokenizer,
            provider: scripted(),
        });
        expect(out.rungs.vetoed).toBeGreaterThanOrEqual(1);
        // It did cite: the rung chose again among what was left, rather than
        // dropping a clause another passage could carry.
        expect(out.rungs.dense).toBe(1);
        expect(out.spans).toHaveLength(1);
        const cited = results.find((r) => r.chunk.id === out.spans[0]!.chunkId)!;
        expect(cited.chunk.text).toContain('em dobro');
        expect(cited.chunk.text).not.toContain('15 dias');
    });

    it('never cites a passage pointing AWAY from the clause', async () => {
        // Every eligible passage here has a negative cosine with the clause.
        // The margin is MULTIPLICATIVE and inverts over negatives, so without
        // the sign guard the least-wrong passage would be cited.
        //
        // TARGET OF THE REVERSAL: delete `if (score <= 0) return;` in
        // `denseRung` and this goes red.
        const results = search('contagem relator perícia');
        const out = await attribute('Isso decorre do exposto acima.', results, {
            tokenizer,
            provider: scripted(),
        });
        expect(out.rungs.dense).toBe(0);
        expect(out.spans).toHaveLength(0);
    });

    it('the counters still partition the clauses when the dense rung runs', async () => {
        const results = search('prazo contagem relator perícia');
        const text = 'O prazo é de 15 dias. Isso vale em regra. Helicópteros sobrevoaram ilhas.';
        const out = await attribute(text, results, {
            tokenizer,
            provider: deterministicProvider(16),
        });
        const { lexical, dense, unattributed } = out.rungs;
        expect(lexical + dense + unattributed).toBe(3);
        expect(lexical).toBeGreaterThanOrEqual(0);
        expect(dense).toBeGreaterThanOrEqual(0);
    });
});
