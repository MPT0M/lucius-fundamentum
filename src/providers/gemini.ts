/**
 * @fileoverview Gemini embeddings.
 *
 * Two things about this API shape the adapter, and both are traps if you
 * assume it works like the others.
 *
 * The first: several `parts` in one request produce ONE aggregated vector, not
 * one per part. That is a feature — it is how text and an image are fused into
 * a single point — and it is exactly the wrong thing for indexing a corpus. An
 * adapter that batched by stuffing chunks into `parts` would return a single
 * vector for six hundred chunks, and the count guard downstream would catch it
 * only because it counts. So each input gets its own request.
 *
 * Which is a property of THIS endpoint, not of the service. `batchEmbed
 * Contents` exists and returns one vector per input, and it would collapse a
 * corpus from six hundred calls to a handful. It is not used here for one
 * reason, stated plainly so nobody mistakes the omission for a finding: the
 * request and response shapes were not read, and writing an adapter against
 * documentation nobody opened is how a wrong field name becomes a silent
 * degradation. Named debt: read that page, then batch.
 *
 * The second: `gemini-embedding-2` dropped the `task_type` parameter its
 * predecessor had. The task is now written into the text, as a prefix the
 * model was trained to read. There is no field to set and no error if you omit
 * it — retrieval is simply worse, silently, which is why the interface carries
 * the distinction at all.
 *
 * One thing to know before reaching for this adapter: the free tier does not
 * serve embeddings over the API at all — the model is reachable only inside
 * the provider's own studio. A key that works for chat will fail here, and the
 * failure arrives as an HTTP error rather than as anything explaining the
 * tier. Indexing a corpus with this adapter needs a paid tier.
 */

import type { EmbeddingProvider } from '../embedding.js';
import { postJson, assertShape, EmbeddingProviderError, requirePositiveInteger } from './http.js';

export interface GeminiOptions {
    readonly apiKey: string;
    /** Defaults to `gemini-embedding-2`. */
    readonly model?: string;
    /** 128 to 3072. Defaults to 1536. */
    readonly dimensions?: number;
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly fetch?: typeof globalThis.fetch;
    /**
     * How many requests to have in flight at once.
     *
     * One request per chunk is what correctness costs here, so a corpus is
     * many round trips; strictly one at a time makes indexing needlessly slow,
     * and all at once earns a rate limit.
     *
     * The default of 8 is sized against the paid tier's published ceilings —
     * 2.9K requests and 970K tokens per minute — using this repository's own
     * corpus of 636 chunks averaging 1119 code points, and assuming 300ms a
     * call:
     *
     *     concurrency  1 -> 191s     7% of RPM,    8% of TPM
     *     concurrency  8 ->  24s    55% of RPM,   62% of TPM
     *     concurrency 16 ->  12s   110% of RPM,  123% of TPM
     *
     * Both ceilings are passed at 16, and tokens are the tighter of the two
     * from 8 upward. Raise this only against a tier whose limits you have
     * read, and read the token limit first.
     *
     * The token column is an ESTIMATE and the request column is not. Requests
     * are counted; tokens are converted from code points at the pessimistic
     * `CODE_POINTS_PER_TOKEN` below, because nobody can count a vendor's
     * tokens without the vendor's tokenizer. An earlier version of this table
     * used the corpus probe's `tokens` field, which counts BM25 index terms
     * after folding and stemming — a different quantity that ran about 1.9x
     * low and inverted the conclusion about which ceiling binds first. The
     * chunk size is measurable here and the conversion is declared, which is
     * the most this file can honestly claim.
     */
    readonly concurrency?: number;
}

/** See the note in the OpenAI adapter: pessimistic on purpose. */
const CODE_POINTS_PER_TOKEN = 3;
const WINDOW_TOKENS = 8192;

/**
 * What the task prefix costs, taken off the window this adapter advertises.
 *
 * This is the only adapter that changes the text before sending it, so it is
 * the only one where the chunk the guard measures and the string that leaves
 * the machine are different objects. `assertChunksFit` checks `chunk.text`;
 * the wire carries the prefix as well. Advertising the full window would let a
 * chunk sitting exactly at the ceiling pass the guard and overflow once the
 * prefix is glued on — the silent truncation the guard exists to refuse.
 *
 * Derived from the prefix builders rather than written as a literal, so
 * editing a prefix cannot leave the number behind.
 */
const PREFIX_CODE_POINTS = Math.max([...asQuery('')].length, [...asDocument('')].length);
const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_CONCURRENCY = 8;

export function geminiProvider(opts: GeminiOptions): EmbeddingProvider {
    const model = opts.model ?? 'gemini-embedding-2';
    const dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
    const id = `gemini:${model}:${dimensions}`;
    const base = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    const concurrency = requirePositiveInteger(opts.concurrency ?? DEFAULT_CONCURRENCY, 'concurrency');

    async function embedOne(text: string): Promise<number[]> {
        const payload = await postJson({
            url: `${base}/models/${model}:embedContent`,
            headers: { 'x-goog-api-key': opts.apiKey },
            body: {
                model: `models/${model}`,
                content: { parts: [{ text }] },
                output_dimensionality: dimensions,
            },
            providerId: id,
            ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
            ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
        });

        const values = (payload as { embedding?: { values?: unknown } }).embedding?.values;
        if (!Array.isArray(values)) {
            throw new EmbeddingProviderError(id, undefined, 'response has no `embedding.values` array');
        }
        return values as number[];
    }

    return {
        id,
        dimensions,
        maxInputCodePoints: WINDOW_TOKENS * CODE_POINTS_PER_TOKEN - PREFIX_CODE_POINTS,

        async embedDocuments(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
            if (texts.length === 0) return [];
            const vectors = await inBatches(
                texts.map((text) => () => embedOne(asDocument(text))),
                concurrency,
            );
            assertShape(vectors, texts.length, dimensions, id);
            return vectors;
        },

        async embedQuery(text: string): Promise<readonly number[]> {
            const vector = await embedOne(asQuery(text));
            assertShape([vector], 1, dimensions, id);
            return vector;
        },
    };
}

/**
 * The prefixes the model was trained to read.
 *
 * They are text, not parameters, so nothing validates them and a typo degrades
 * retrieval instead of failing. They live here, in one place, for that reason:
 * spelled out at each call site they would drift, and the drift would be
 * invisible.
 */
function asQuery(text: string): string {
    return `task: search result | query: ${text}`;
}

function asDocument(text: string): string {
    return `title: none | text: ${text}`;
}

/**
 * Runs the calls with a ceiling on how many are in flight, preserving order.
 *
 * Written out rather than pulled in: this library has no dependencies, and the
 * alternative shapes are both wrong here. `Promise.all` over six hundred
 * requests earns a rate limit; a sequential loop turns a corpus into a coffee
 * break.
 *
 * The first rejection stops the queue. What it cannot stop is the handful
 * already in flight, which have left the machine and will be paid for: at most
 * `limit - 1` extra calls, bounded and declared, rather than the remainder of
 * the corpus. Cancelling those would mean threading an `AbortSignal` from here
 * into every request, which is worth doing the day something needs to cancel
 * an index build on purpose.
 */
async function inBatches<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
    const out = new Array<T>(tasks.length);
    let next = 0;
    let failed = false;

    async function worker(): Promise<void> {
        for (;;) {
            if (failed) return;

            // Without this the first rejection kills only the worker that saw
            // it: `Promise.all` hands the error to the caller while the other
            // workers keep draining the queue, paying for results nobody will
            // read. On a corpus this size that is hundreds of requests made
            // after the caller already gave up — and if the cause was a rate
            // limit, they hammer an endpoint that just said to stop. The
            // subsequent rejections are swallowed by `Promise.all`, so not
            // even an unhandled rejection announces it.

            const index = next;
            next += 1;
            if (index >= tasks.length) return;

            try {
                out[index] = await tasks[index]!();
            } catch (cause) {
                failed = true;
                throw cause;
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
    return out;
}
