import { describe, it, expect } from 'vitest';
import {
    attribute,
    attributeLexical,
    createIndex,
    createTokenizer,
    type AttributeState,
    type EmbeddingProvider,
    type SourceDoc,
    type SearchResult,
} from '../src/index.js';
import { EmbeddingCheckError } from '../src/embedding.js';
import { EmbeddingProviderError } from '../src/providers/http.js';

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

const unit = (v: readonly number[]) => {
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
};

/** Resolves the clause about the relator densely; everything else points away. */
const scripted: EmbeddingProvider = {
    id: 'scripted',
    dimensions: 3,
    maxInputCodePoints: 100_000,
    async embedDocuments(texts) {
        return texts.map((t) =>
            /relator|suspensiv|agravo/i.test(t) ? unit([1, 0, 0]) : unit([-1, 1, 0]),
        );
    },
    async embedQuery() {
        return unit([-1, 1, 0]);
    },
};

/** Every clause resolves on the words, so the network is never reached. */
const ALL_LEXICAL =
    'O prazo para recurso é de 15 dias corridos. ' +
    'A contagem exclui o dia inicial e inclui o do vencimento.';

/** The middle clause needs the vectors. */
const NEEDS_VECTORS =
    'O prazo para recurso é de 15 dias corridos. ' +
    'O prazo do relator. ' +
    'A perícia contábil será custeada pela parte requerente.';

async function kindsOf(text: string, opts: Record<string, unknown>): Promise<string[]> {
    const seen: AttributeState[] = [];
    await attribute(text, search('prazo contagem relator perícia'), {
        tokenizer,
        onState: (event) => seen.push(event),
        ...opts,
    });
    return seen.map((e) => e.kind);
}

describe('the wait event exists only when there is a wait', () => {
    it('no provider: the sequence ends at local-done', async () => {
        // TARGET OF THE REVERSAL: emit `provider-wait` at the start of the work
        // instead of before the network. An indicator hung on it would then
        // flash for the few milliseconds the local pass takes and vanish, in
        // this case and in the one below.
        expect(await kindsOf(NEEDS_VECTORS, {})).toEqual(['local-done']);
    });

    it('a provider but nothing pending: still no wait, because the network is not called', async () => {
        // Measured: every clause of ALL_LEXICAL resolves on the words, so
        // `pending` is empty and the provider is never reached — even though
        // one was passed.
        expect(await kindsOf(ALL_LEXICAL, { provider: scripted })).toEqual(['local-done']);
    });

    it('a provider and a pending clause: the wait appears once, and closes once', async () => {
        // ONCE, not twice: `attribute` makes two trips to the network and they
        // are one wait from where the reader stands.
        expect(await kindsOf(NEEDS_VECTORS, { provider: scripted })).toEqual([
            'local-done',
            'provider-wait',
            'provider-done',
        ]);
    });
});

describe('a failure closes the sequence, and provider-done does not follow it', () => {
    it('provider-failed replaces provider-done, never joins it', async () => {
        // TARGET OF THE REVERSAL: emit `provider-done` after the try/catch
        // regardless. `provider-done` means the vectors are available, and half
        // an answer does not make them available.
        const failing: EmbeddingProvider = {
            ...scripted,
            async embedDocuments() {
                throw new EmbeddingProviderError('p', 429, 'slow down');
            },
        };
        const kinds = await kindsOf(NEEDS_VECTORS, { provider: failing });
        expect(kinds).toEqual(['local-done', 'provider-wait', 'provider-failed']);
        expect(kinds).not.toContain('provider-done');
    });

    it('the failure event carries the same classification the result carries', async () => {
        const failing: EmbeddingProvider = {
            ...scripted,
            async embedDocuments() {
                throw new EmbeddingProviderError('p', 401, 'no');
            },
        };
        const seen: AttributeState[] = [];
        const out = await attribute(NEEDS_VECTORS, search('prazo contagem relator perícia'), {
            tokenizer,
            provider: failing,
            onState: (event) => seen.push(event),
        });
        const event = seen.find((e) => e.kind === 'provider-failed');
        expect(event).toBeDefined();
        expect((event as { failure: unknown }).failure).toEqual(out.providerFailure);
    });
});

describe('the preview is what the local rungs found, and it is REPLACED', () => {
    it('the preview equals what the lexical door answers for the same text', async () => {
        // TARGET OF THE REVERSAL: emit the envelope built after the dense rung
        // instead of before it. The preview would then arrive already carrying
        // dense spans, which is not what "the local rungs are done" means.
        const results = search('prazo contagem relator perícia');
        let preview: unknown;
        await attribute(NEEDS_VECTORS, results, {
            tokenizer,
            provider: scripted,
            onState: (event) => {
                if (event.kind === 'local-done') preview = event.preview;
            },
        });
        const local = attributeLexical(NEEDS_VECTORS, results, { tokenizer });
        expect(preview).toEqual(local);
    });

    it('the final result is not the preview: a marker moved between them', async () => {
        // This is what "REPLACES, does not amend" costs, shown rather than
        // asserted in prose. A consumer that patches marker by marker drifts.
        const results = search('prazo contagem relator perícia');
        let preview: { spans: readonly unknown[] } | undefined;
        const full = await attribute(NEEDS_VECTORS, results, {
            tokenizer,
            provider: scripted,
            onState: (event) => {
                if (event.kind === 'local-done') preview = event.preview;
            },
        });
        expect(preview).toBeDefined();
        expect(full.spans).not.toEqual(preview!.spans);
    });
});

describe('without onState the result is unchanged', () => {
    it('the same call with and without the callback answers the same thing', async () => {
        // The guarantee that the preview is not CONSTRUCTED is by construction:
        // `finish` for the preview is called inside the `if (opts.onState)`.
        // That is visible in three lines and is not separately testable without
        // adding a seam to `finish` — declared here rather than claimed proved.
        const results = search('prazo contagem relator perícia');
        const quiet = await attribute(NEEDS_VECTORS, results, { tokenizer, provider: scripted });
        const loud = await attribute(NEEDS_VECTORS, results, {
            tokenizer,
            provider: scripted,
            onState: () => {},
        });
        expect(quiet).toEqual(loud);
    });

    it('and the same holds on the FAILED path, which is where they could differ', async () => {
        // The test above compares two successful calls, and `providerFailure`
        // is absent on both sides — so it proves nothing about that field. The
        // catch branch is the only path where the
        // envelope carries it AND the callback is invoked, so it is the only
        // one where a divergence could hide.
        const results = search('prazo contagem relator perícia');
        const failing: EmbeddingProvider = {
            ...scripted,
            async embedDocuments() {
                throw new EmbeddingProviderError('p', 429, 'slow down');
            },
        };
        const quiet = await attribute(NEEDS_VECTORS, results, { tokenizer, provider: failing });
        const loud = await attribute(NEEDS_VECTORS, results, {
            tokenizer,
            provider: failing,
            onState: () => {},
        });
        expect(quiet).toEqual(loud);
        expect(quiet.providerFailure).toMatchObject({ reason: 'quota', retryable: true });
    });
});

describe('a configuration error rejects AFTER local-done', () => {
    it('the sequence stops at local-done and the promise still rejects', async () => {
        // TARGET OF THE REVERSAL: move `assertChunksFit` above the emission of
        // `local-done`, or inside the try/catch. The first makes the sequence
        // empty; the second turns the rejection into a silent degrade.
        //
        // The contract table lists this outcome and no test entered it. It is
        // the one a consumer gets wrong: `local-done` has already fired when
        // the promise rejects, so an indicator cleared on resolve alone spins
        // forever. The other three outcomes all resolve.
        //
        // A window of 40 refuses every candidate. The measurement behind that
        // lives with the test written for it, in `attribute-degrade.test.ts`,
        // and is not restated here: two copies of a number drift apart.
        const narrow: EmbeddingProvider = { ...scripted, maxInputCodePoints: 40 };
        const seen: AttributeState[] = [];

        await expect(
            attribute(NEEDS_VECTORS, search('prazo contagem relator perícia'), {
                tokenizer,
                provider: narrow,
                onState: (event) => seen.push(event),
            }),
        ).rejects.toThrow(EmbeddingCheckError);

        expect(seen.map((e) => e.kind)).toEqual(['local-done']);
    });
});
