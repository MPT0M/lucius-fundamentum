import { describe, it, expect } from 'vitest';
import { openAiProvider } from '../src/providers/openai.js';
import { geminiProvider } from '../src/providers/gemini.js';
import { qwenProvider } from '../src/providers/qwen.js';
import { EmbeddingProviderError } from '../src/providers/http.js';

interface Call {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: Record<string, unknown>;
}

/** A fetch that records what it was asked and answers with what it is told. */
function recorder(reply: (call: Call, n: number) => { status?: number; body: unknown | string }) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const call: Call = {
            url: String(url),
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        };
        calls.push(call);
        const { status = 200, body } = reply(call, calls.length - 1);
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return new Response(text, { status });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetchImpl };
}

const vector = (n: number, fill = 0.5) => Array.from({ length: n }, () => fill);

describe('openai adapter', () => {
    it('sends every text in one call and reads the vectors back', async () => {
        const { calls, fetchImpl } = recorder((call) => ({
            body: {
                data: (call.body.input as string[]).map((_, i) => ({ index: i, embedding: vector(1536) })),
            },
        }));
        const provider = openAiProvider({ apiKey: 'k', fetch: fetchImpl });

        const out = await provider.embedDocuments(['um', 'dois', 'três']);
        expect(out).toHaveLength(3);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('https://api.openai.com/v1/embeddings');
        expect(calls[0]!.headers.authorization).toBe('Bearer k');
        expect(calls[0]!.body.input).toEqual(['um', 'dois', 'três']);
        expect(calls[0]!.body.model).toBe('text-embedding-3-small');
    });

    it('orders by the index the API reports, not by arrival', async () => {
        // The contract is that each entry names its own position. Arrival
        // order agreeing with it is a convenience, not a promise, and the day
        // it stops every chunk would hold a neighbour's vector in silence.
        const { fetchImpl } = recorder(() => ({
            body: {
                data: [
                    { index: 2, embedding: vector(1536, 0.3) },
                    { index: 0, embedding: vector(1536, 0.1) },
                    { index: 1, embedding: vector(1536, 0.2) },
                ],
            },
        }));
        const provider = openAiProvider({ apiKey: 'k', fetch: fetchImpl });
        const out = await provider.embedDocuments(['a', 'b', 'c']);
        expect(out[0]![0]).toBeCloseTo(0.1);
        expect(out[1]![0]).toBeCloseTo(0.2);
        expect(out[2]![0]).toBeCloseTo(0.3);
    });

    it('sends no dimensions field unless one was asked for', async () => {
        const { calls, fetchImpl } = recorder(() => ({
            body: { data: [{ index: 0, embedding: vector(1536) }] },
        }));
        await openAiProvider({ apiKey: 'k', fetch: fetchImpl }).embedQuery('q');
        expect('dimensions' in calls[0]!.body).toBe(false);
    });

    it('embeds a query exactly like a document, because this provider has no asymmetry', async () => {
        const { calls, fetchImpl } = recorder(() => ({
            body: { data: [{ index: 0, embedding: vector(1536) }] },
        }));
        const provider = openAiProvider({ apiKey: 'k', fetch: fetchImpl });
        await provider.embedQuery('posso usar celular?');
        expect(calls[0]!.body.input).toEqual(['posso usar celular?']);
    });

    it('refuses a model whose width it does not know, rather than guessing', async () => {
        expect(() => openAiProvider({ apiKey: 'k', model: 'some-future-model' })).toThrow(/dimensions/);
        expect(() =>
            openAiProvider({ apiKey: 'k', model: 'some-future-model', dimensions: 512 }),
        ).not.toThrow();
    });

    it('names the provider, the status and the body when the call fails', async () => {
        const { fetchImpl } = recorder(() => ({ status: 429, body: { error: { message: 'rate limit' } } }));
        const provider = openAiProvider({ apiKey: 'k', fetch: fetchImpl });
        await expect(provider.embedQuery('q')).rejects.toThrow(/429/);
        await expect(provider.embedQuery('q')).rejects.toThrow(/rate limit/);
    });

    it('refuses a response missing an index', async () => {
        const { fetchImpl } = recorder(() => ({
            body: { data: [{ index: 0, embedding: vector(1536) }] },
        }));
        const provider = openAiProvider({ apiKey: 'k', fetch: fetchImpl });
        await expect(provider.embedDocuments(['a', 'b'])).rejects.toThrow(/no entry for index 1/);
    });

    it('refuses a vector of the wrong width', async () => {
        const { fetchImpl } = recorder(() => ({ body: { data: [{ index: 0, embedding: vector(8) }] } }));
        await expect(openAiProvider({ apiKey: 'k', fetch: fetchImpl }).embedQuery('q')).rejects.toThrow(
            /8-dimension vector at position 0/,
        );
    });
});

describe('gemini adapter', () => {
    it('sends one request per text, because several parts would fuse into one vector', async () => {
        // The trap this adapter exists to avoid: batching by stuffing chunks
        // into `parts` returns a single aggregated vector for the whole batch,
        // which is a feature for multimodal fusion and ruin for indexing.
        const { calls, fetchImpl } = recorder(() => ({ body: { embedding: { values: vector(1536) } } }));
        const provider = geminiProvider({ apiKey: 'k', fetch: fetchImpl });

        const out = await provider.embedDocuments(['um', 'dois', 'três']);
        expect(out).toHaveLength(3);
        expect(calls).toHaveLength(3);
        for (const call of calls) {
            expect((call.body.content as { parts: unknown[] }).parts).toHaveLength(1);
        }
    });

    it('marks a query as a query and a document as a document, in the text itself', async () => {
        // There is no field for this on this model: the task is a prefix the
        // model was trained to read, so nothing validates it and omitting it
        // degrades retrieval with no error.
        const { calls, fetchImpl } = recorder(() => ({ body: { embedding: { values: vector(1536) } } }));
        const provider = geminiProvider({ apiKey: 'k', fetch: fetchImpl });

        await provider.embedQuery('posso usar celular?');
        const queryText = ((calls[0]!.body.content as { parts: { text: string }[] }).parts[0]!).text;
        expect(queryText).toContain('query:');
        expect(queryText).toContain('posso usar celular?');

        await provider.embedDocuments(['Art. 2º Fica proibido o uso']);
        const docText = ((calls[1]!.body.content as { parts: { text: string }[] }).parts[0]!).text;
        expect(docText).toContain('text:');
        expect(docText).not.toContain('query:');
    });

    it('uses the key header this API wants, not a bearer token', async () => {
        const { calls, fetchImpl } = recorder(() => ({ body: { embedding: { values: vector(1536) } } }));
        await geminiProvider({ apiKey: 'k', fetch: fetchImpl }).embedQuery('q');
        expect(calls[0]!.headers['x-goog-api-key']).toBe('k');
        expect(calls[0]!.headers.authorization).toBeUndefined();
    });

    it('keeps the order of the inputs even though the requests run concurrently', async () => {
        // Order is what ties a vector to its chunk. Concurrency that returned
        // them shuffled would misalign the whole index with nothing raising.
        const { fetchImpl } = recorder((call) => {
            const text = ((call.body.content as { parts: { text: string }[] }).parts[0]!).text;
            const n = Number(text.match(/\d+/u)![0]);
            return { body: { embedding: { values: vector(1536, n / 100) } } };
        });
        const provider = geminiProvider({ apiKey: 'k', fetch: fetchImpl, concurrency: 4 });
        const out = await provider.embedDocuments(Array.from({ length: 20 }, (_, i) => `texto ${i}`));
        for (let i = 0; i < 20; i += 1) expect(out[i]![0]).toBeCloseTo(i / 100, 6);
    });

    it('stops the queue on the first failure instead of paying for the rest', async () => {
        // Regression. Each rejection killed only the worker that saw it:
        // Promise.all handed the error to the caller while the other workers
        // kept draining the queue, and the later rejections were swallowed. On
        // a corpus this meant hundreds of calls made after the caller gave up,
        // and a rate limit answered by more requests.
        const { calls, fetchImpl } = recorder((_call, n) =>
            n === 2 ? { status: 429, body: 'slow down' } : { body: { embedding: { values: vector(1536) } } },
        );
        const provider = geminiProvider({ apiKey: 'k', fetch: fetchImpl, concurrency: 4 });

        await expect(provider.embedDocuments(Array.from({ length: 200 }, (_, i) => `t${i}`))).rejects.toThrow(
            EmbeddingProviderError,
        );

        // The exact count, not a tolerance. The previous version allowed up to
        // `4 + 4` while the JSDoc promised `limit - 1` extras — two numbers,
        // neither measured, and the looser one would have passed a regression
        // that doubled the waste. Measured across twelve configurations
        // (concurrency 4 and 8, failure at call 0, 3 and 10, with and without
        // a resolve delay): the overshoot is exactly `limit - 1` every time,
        // because `failed` is set in the same microtask as the rejection and
        // every sibling sees it before its next turn of the loop.
        // Here: 3 calls through the failure at index 2, plus 3 siblings in flight.
        expect(calls.length).toBe(6);
    });

    it('keeps at most `concurrency` requests in flight', async () => {
        // The previous version of this test passed `concurrency: 4` and only
        // checked the output order, which `Promise.all` over every task
        // satisfies too — the option was inert as far as the suite could tell,
        // and it is the option the whole rate-limit table rests on.
        let inFlight = 0;
        let peak = 0;
        const release: (() => void)[] = [];
        const fetchImpl = (() => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            return new Promise((resolve) => {
                release.push(() => {
                    inFlight -= 1;
                    resolve(new Response(JSON.stringify({ embedding: { values: vector(1536) } })));
                });
            });
        }) as unknown as typeof globalThis.fetch;

        const provider = geminiProvider({ apiKey: 'k', fetch: fetchImpl, concurrency: 3 });
        const pending = provider.embedDocuments(Array.from({ length: 12 }, (_, i) => `t${i}`));

        // Drain by letting one finish at a time, so a ceiling higher than 3
        // would show up as a peak higher than 3.
        for (let done = 0; done < 12; done += 1) {
            while (release.length === 0) await Promise.resolve();
            release.shift()!();
            await Promise.resolve();
        }
        await pending;

        expect(peak).toBe(3);
    });

    it('refuses a concurrency that is not a whole number, instead of silently doing nothing', () => {
        // Math.max(1, NaN) is NaN, and NaN workers produce an empty loop, a
        // result array of holes, and a TypeError far from the cause.
        // Number(process.env.CONCURRENCY) on an unset variable is enough.
        expect(() => geminiProvider({ apiKey: 'k', concurrency: Number.NaN })).toThrow(/whole number/u);
        expect(() => geminiProvider({ apiKey: 'k', concurrency: 0 })).toThrow(/whole number/u);
        expect(() => geminiProvider({ apiKey: 'k', concurrency: 2.5 })).toThrow(/whole number/u);
    });

    it('takes the whole task prefix off the window it advertises', () => {
        // This is the only adapter that changes the text before sending it, so
        // the chunk the guard measures is not the string that ships.
        //
        // The assertion is the exact figure, because the dangerous direction is
        // a discount that is too SMALL — that is what lets a chunk sitting at
        // the ceiling overflow once the prefix is glued on, which is the silent
        // truncation the guard exists to refuse. `toBeLessThan` passed on a
        // discount of one code point and would have caught none of it.
        const bare = 8192 * 3;
        // `task: search result | query: ` is the longer of the two prefixes.
        const longest = [...'task: search result | query: '].length;
        expect(geminiProvider({ apiKey: 'k' }).maxInputCodePoints).toBe(bare - longest);
    });

    it('asks for the dimension count it declares', async () => {
        const { calls, fetchImpl } = recorder(() => ({ body: { embedding: { values: vector(768) } } }));
        const provider = geminiProvider({ apiKey: 'k', dimensions: 768, fetch: fetchImpl });
        expect(provider.dimensions).toBe(768);
        await provider.embedQuery('q');
        expect(calls[0]!.body.output_dimensionality).toBe(768);
    });

    it('refuses a response without the embedding it promised', async () => {
        const { fetchImpl } = recorder(() => ({ body: { somethingElse: true } }));
        await expect(geminiProvider({ apiKey: 'k', fetch: fetchImpl }).embedQuery('q')).rejects.toThrow(
            /embedding\.values/,
        );
    });
});

describe('qwen adapter', () => {
    it('splits a corpus into runs of the documented ceiling', async () => {
        const { calls, fetchImpl } = recorder((call) => ({
            body: {
                output: {
                    embeddings: ((call.body.input as { texts: string[] }).texts).map((_, i) => ({
                        text_index: i,
                        embedding: vector(1024),
                    })),
                },
            },
        }));
        const provider = qwenProvider({ apiKey: 'k', fetch: fetchImpl, batchSize: 3 });

        const out = await provider.embedDocuments(Array.from({ length: 7 }, (_, i) => `t${i}`));
        expect(out).toHaveLength(7);
        expect(calls).toHaveLength(3);
        expect((calls[0]!.body.input as { texts: string[] }).texts).toHaveLength(3);
        expect((calls[2]!.body.input as { texts: string[] }).texts).toHaveLength(1);
    });

    it('sets text_type, which is the only first-class asymmetry of the three', async () => {
        const { calls, fetchImpl } = recorder(() => ({
            body: { output: { embeddings: [{ text_index: 0, embedding: vector(1024) }] } },
        }));
        const provider = qwenProvider({ apiKey: 'k', fetch: fetchImpl });

        await provider.embedQuery('posso usar celular?');
        expect((calls[0]!.body.parameters as { text_type: string }).text_type).toBe('query');
        // And the text goes through untouched: no prefix to write, so none is.
        expect((calls[0]!.body.input as { texts: string[] }).texts).toEqual(['posso usar celular?']);

        await provider.embedDocuments(['Art. 2º']);
        expect((calls[1]!.body.parameters as { text_type: string }).text_type).toBe('document');
    });

    it('orders by text_index, not by arrival', async () => {
        const { fetchImpl } = recorder(() => ({
            body: {
                output: {
                    embeddings: [
                        { text_index: 1, embedding: vector(1024, 0.2) },
                        { text_index: 0, embedding: vector(1024, 0.1) },
                    ],
                },
            },
        }));
        const out = await qwenProvider({ apiKey: 'k', fetch: fetchImpl }).embedDocuments(['a', 'b']);
        expect(out[0]![0]).toBeCloseTo(0.1);
        expect(out[1]![0]).toBeCloseTo(0.2);
    });

    it('a 401 from the default host names the other host, because the key is not the culprit', async () => {
        // Measured 2026-09-13: a valid international key gets 401
        // InvalidApiKey from the mainland host and a 1024-wide vector from the
        // international one. Without this the reader regenerates a key that
        // was never the problem.
        const { fetchImpl } = recorder(() => ({ status: 401, body: { code: 'InvalidApiKey' } }));
        await expect(qwenProvider({ apiKey: 'k', fetch: fetchImpl }).embedQuery('q')).rejects.toThrow(
            /dashscope-intl\.aliyuncs\.com/u,
        );
    });

    it('does not blame the host when the caller already chose one', async () => {
        // The hint is only true of the default. Pinned so it cannot turn into
        // advice pasted onto every 401 anyone ever gets.
        const { fetchImpl } = recorder(() => ({ status: 401, body: { code: 'InvalidApiKey' } }));
        const provider = qwenProvider({ apiKey: 'k', fetch: fetchImpl, baseUrl: 'https://example.test/e' });
        await expect(provider.embedQuery('q')).rejects.not.toThrow(/dashscope-intl/u);
    });

    it('refuses to guess the batch ceiling of a model it has not seen', () => {
        // The ceiling is per model — text-embedding-v4 documents ten against
        // this one's twenty — and inheriting the default would send a batch
        // over the limit that the caller would read as a bug in this library.
        // Same rule the OpenAI adapter applies to vector width.
        expect(() => qwenProvider({ apiKey: 'k', model: 'text-embedding-v4' })).toThrow(/batchSize/u);
        expect(() => qwenProvider({ apiKey: 'k', model: 'text-embedding-v4', batchSize: 10 })).not.toThrow();
    });

    it('refuses a batch size that is not a whole number', () => {
        expect(() => qwenProvider({ apiKey: 'k', batchSize: Number.NaN })).toThrow(/whole number/u);
        expect(() => qwenProvider({ apiKey: 'k', batchSize: 0 })).toThrow(/whole number/u);
    });

    it('carries a window wide enough that the chunk guard is inert for it', () => {
        // Worth pinning: this provider is the reason the guard cannot be a
        // library-wide constant. Its window is two orders larger than the
        // others', and the guard still has to bite for them.
        const qwen = qwenProvider({ apiKey: 'k' });
        const openai = openAiProvider({ apiKey: 'k' });
        expect(qwen.maxInputCodePoints).toBeGreaterThan(openai.maxInputCodePoints * 10);
    });

    it('refuses a response shaped like another provider', async () => {
        const { fetchImpl } = recorder(() => ({ body: { data: [{ index: 0, embedding: vector(1024) }] } }));
        await expect(qwenProvider({ apiKey: 'k', fetch: fetchImpl }).embedQuery('q')).rejects.toThrow(
            /output\.embeddings/,
        );
    });
});

describe('every adapter — the shared failures', () => {
    const build = {
        openai: (f: typeof globalThis.fetch) => openAiProvider({ apiKey: 'k', fetch: f }),
        gemini: (f: typeof globalThis.fetch) => geminiProvider({ apiKey: 'k', fetch: f }),
        qwen: (f: typeof globalThis.fetch) => qwenProvider({ apiKey: 'k', fetch: f }),
    };

    it('a 200 carrying something that is not JSON is named as such', async () => {
        for (const [name, make] of Object.entries(build)) {
            const { fetchImpl } = recorder(() => ({ body: '<html>login</html>' }));
            await expect(make(fetchImpl).embedQuery('q'), name).rejects.toThrow(/not JSON/);
        }
    });

    it('an empty input list is an empty result, without a call', async () => {
        for (const [name, make] of Object.entries(build)) {
            const { calls, fetchImpl } = recorder(() => ({ body: {} }));
            expect(await make(fetchImpl).embedDocuments([]), name).toEqual([]);
            expect(calls, name).toHaveLength(0);
        }
    });

    it('the error carries the provider id, so a multi-provider setup says which one failed', async () => {
        // The assertion reads the two fields by name. Checking only the class
        // would leave both free to be removed, or filled with the wrong value,
        // with this test still green under a name that promises otherwise.
        const expected = {
            openai: 'openai:text-embedding-3-small:1536',
            gemini: 'gemini:gemini-embedding-2:1536',
            qwen: 'qwen:qwen3.7-text-embedding:1024',
        };
        for (const [name, make] of Object.entries(build)) {
            const { fetchImpl } = recorder(() => ({ status: 500, body: 'boom' }));
            const error = await make(fetchImpl)
                .embedQuery('q')
                .then(() => undefined)
                .catch((e: unknown) => e);
            expect(error, name).toBeInstanceOf(EmbeddingProviderError);
            expect((error as EmbeddingProviderError).providerId, name).toBe(
                expected[name as keyof typeof expected],
            );
            expect((error as EmbeddingProviderError).status, name).toBe(500);
        }
    });

    it('a fetch that throws becomes a provider error instead of escaping raw', async () => {
        // The network failure that matters is the one where fetch REJECTS —
        // DNS, a dropped socket, the abort signal firing. Translating it is
        // what keeps the provider id and the status on the way out, and no
        // network is needed to test the translation.
        for (const [name, make] of Object.entries(build)) {
            const fetchImpl = (() =>
                Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as unknown as typeof globalThis.fetch;
            const error = await make(fetchImpl)
                .embedQuery('q')
                .then(() => undefined)
                .catch((e: unknown) => e);
            expect(error, name).toBeInstanceOf(EmbeddingProviderError);
            expect((error as EmbeddingProviderError).message, name).toMatch(/request failed: .*ENOTFOUND/u);
            expect((error as EmbeddingProviderError).status, name).toBeUndefined();
        }
    });

    it('a body that dies mid-read fails as a provider error, not as a raw network exception', async () => {
        // Regression: the body read used to sit outside the try that guards
        // the request. The timeout covers the whole exchange, so a large
        // response arriving slowly aborts HERE — the common case for a corpus,
        // not an exotic one — and the caller lost the id and status.
        for (const [name, make] of Object.entries(build)) {
            const fetchImpl = (() =>
                Promise.resolve({
                    ok: true,
                    status: 200,
                    text: () => Promise.reject(new Error('terminated')),
                })) as unknown as typeof globalThis.fetch;
            const error = await make(fetchImpl)
                .embedQuery('q')
                .then(() => undefined)
                .catch((e: unknown) => e);
            expect(error, name).toBeInstanceOf(EmbeddingProviderError);
            expect((error as EmbeddingProviderError).message, name).toMatch(/request failed: terminated/u);
        }
    });

    it('says so when there is no fetch to use, instead of failing as a type error', async () => {
        const provider = openAiProvider({ apiKey: 'k', fetch: undefined as unknown as typeof globalThis.fetch });
        const saved = globalThis.fetch;
        try {
            (globalThis as { fetch?: unknown }).fetch = undefined;
            await expect(provider.embedQuery('q')).rejects.toThrow(/no fetch available/u);
        } finally {
            globalThis.fetch = saved;
        }
    });

    it('every request carries the timeout signal', async () => {
        // Without this the AbortSignal line can be deleted and the suite stays
        // green: the recorder ignores init, so nothing else observes it.
        for (const [name, make] of Object.entries(build)) {
            let seen: unknown;
            const fetchImpl = ((_url: string, init?: RequestInit) => {
                seen = init?.signal;
                return Promise.resolve(new Response(JSON.stringify({ nope: true })));
            }) as unknown as typeof globalThis.fetch;
            await make(fetchImpl)
                .embedQuery('q')
                .catch(() => undefined);
            expect(seen, name).toBeInstanceOf(AbortSignal);
        }
    });

    it('every id names the provider, the model and the width', () => {
        expect(openAiProvider({ apiKey: 'k' }).id).toBe('openai:text-embedding-3-small:1536');
        expect(geminiProvider({ apiKey: 'k' }).id).toBe('gemini:gemini-embedding-2:1536');
        expect(qwenProvider({ apiKey: 'k' }).id).toBe('qwen:qwen3.7-text-embedding:1024');
    });
});
