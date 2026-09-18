import { describe, it, expect } from 'vitest';
import {
    attribute,
    attributeLexical,
    createIndex,
    createTokenizer,
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

/** A provider whose only job is to fail the way the caller asked it to. */
function failing(error: unknown): EmbeddingProvider {
    return {
        id: 'failing',
        dimensions: 3,
        maxInputCodePoints: 100_000,
        async embedDocuments() {
            throw error;
        },
        async embedQuery() {
            throw error;
        },
    };
}

const ANSWER =
    'O prazo para recurso é de 15 dias corridos. ' +
    'O prazo do relator. ' +
    'A perícia contábil será custeada pela parte requerente.';

describe('a remote failure does not destroy local work', () => {
    const results = search('prazo contagem relator perícia');

    it('the answer is what the local rungs found, not an exception', async () => {
        // TARGET OF THE REVERSAL: remove the try/catch and let the exception
        // through, which is what an unguarded await does. Then a caller WITH a key
        // receives nothing where a caller WITHOUT one receives the lexical
        // chips — having a key would deliver less than not having one.
        const degraded = await attribute(ANSWER, results, {
            tokenizer,
            provider: failing(new EmbeddingProviderError('p', 500, 'boom')),
        });
        const local = attributeLexical(ANSWER, results, { tokenizer });

        expect(degraded.spans).toEqual(local.spans);
        expect(degraded.rungs.dense).toBe(0);
    });

    it('the result says the rung was TRIED, which is what tells it apart', async () => {
        // Without this field a failed provider and an absent provider are the
        // same shape: `rungs.dense === 0` in both. The degradation would be
        // silent for every caller who did not ask for events.
        const degraded = await attribute(ANSWER, results, {
            tokenizer,
            provider: failing(new EmbeddingProviderError('p', 500, 'boom')),
        });
        const noProvider = await attribute(ANSWER, results, { tokenizer });

        expect(degraded.providerFailure).toBeDefined();
        expect(noProvider.providerFailure).toBeUndefined();
        expect(degraded.rungs.dense).toBe(noProvider.rungs.dense);
    });
});

describe('the classification reads a number, never prose', () => {
    const results = search('prazo contagem relator perícia');

    const reasonOf = async (error: unknown) => {
        const out = await attribute(ANSWER, results, { tokenizer, provider: failing(error) });
        return out.providerFailure;
    };

    it('401 and 403 are not worth retrying; 429 is', async () => {
        // TARGET OF THE REVERSAL: classify everything the provider throws as
        // `network`/`retryable: true`. A caller then offers a retry button on
        // an expired key, and the user presses it to receive the same error.
        expect(await reasonOf(new EmbeddingProviderError('p', 401, 'no'))).toMatchObject({
            reason: 'auth',
            retryable: false,
        });
        expect(await reasonOf(new EmbeddingProviderError('p', 403, 'no'))).toMatchObject({
            reason: 'auth',
            retryable: false,
        });
        expect(await reasonOf(new EmbeddingProviderError('p', 429, 'slow down'))).toMatchObject({
            reason: 'quota',
            retryable: true,
        });
    });

    it('a 504 is a timeout and a 500 is network, both worth retrying', async () => {
        expect(await reasonOf(new EmbeddingProviderError('p', 504, 'gateway'))).toMatchObject({
            reason: 'timeout',
            retryable: true,
        });
        expect(await reasonOf(new EmbeddingProviderError('p', 500, 'oops'))).toMatchObject({
            reason: 'network',
            retryable: true,
        });
    });

    it('with no status, only the timeout separates — and that is the declared limit', async () => {
        const timeout = new EmbeddingProviderError(
            'p',
            undefined,
            'request failed',
            Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
        );
        expect(await reasonOf(timeout)).toMatchObject({ reason: 'timeout', retryable: true });

        // A refused connection and an unknown host both land here as `network`.
        // The limit is written down in CHANGELOG, and it is SMALLER than a
        // missing contract: the discriminator exists — a `fetch` failure in Node
        // carries `cause.cause.code` — and it is runtime-dependent, while this
        // package declares Node, workerd, Bun and the browser.
        const refused = new EmbeddingProviderError(
            'p',
            undefined,
            'request failed',
            Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
        );
        expect(await reasonOf(refused)).toMatchObject({ reason: 'network', retryable: true });
    });

    it('our own post-network checks say so, and are not worth retrying', async () => {
        // `bad-count` and `bad-dimensions` arrive AFTER the call was paid for
        // and answered. They degrade. Repeating cannot fix a provider that
        // returns the wrong shape.
        expect(await reasonOf(new EmbeddingCheckError('bad-count', 'short'))).toMatchObject({
            reason: 'bad-count',
            retryable: false,
        });
        expect(await reasonOf(new EmbeddingCheckError('bad-dimensions', 'wide'))).toMatchObject({
            reason: 'bad-dimensions',
            retryable: false,
        });
    });
});

describe('what is checked BEFORE the network still throws', () => {
    const results = search('prazo contagem relator perícia');

    it('a clause past the provider window is not degraded into silence', async () => {
        // TARGET OF THE REVERSAL: widen the try/catch to cover `assertChunksFit`
        // — the "catch everything" edit someone makes without thinking. Then a
        // misconfigured provider degrades quietly forever instead of saying so
        // once.
        //
        // Measured: the search returns four candidate chunks and the smallest
        // is 43 code points, so a window of 40 refuses every one. Stated by
        // the smallest rather than by the list, because a different `topK`
        // changes which chunks come back and not that the smallest is
        // already over the window.
        const narrow: EmbeddingProvider = {
            ...failing(new Error('never reached')),
            maxInputCodePoints: 40,
        };
        await expect(attribute(ANSWER, results, { tokenizer, provider: narrow })).rejects.toThrow(
            EmbeddingCheckError,
        );
    });
});
