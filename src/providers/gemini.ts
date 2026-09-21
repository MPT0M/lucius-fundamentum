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

import type { PageImage } from '../chunker.js';
import type { EmbeddingModality, EmbeddingProvider } from '../embedding.js';
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
     * Both ceilings are passed at 16, and tokens are the tighter of the two on
     * EVERY line, including the first: the two columns scale with the same
     * factor, so their ratio does not depend on concurrency at all. It is
     * `(1119 / r) * 2900 / 970000`, which at `r = 3` code points per token is
     * 1.115 — the 8% against 7% on the concurrency-1 line is the same 1.115 as
     * the 123% against 110% at sixteen.
     *
     * That ratio crosses 1.0 at **r = 3.35**, and above it requests become the
     * tighter ceiling again. The OpenAI adapter in this same package puts
     * Portuguese prose "near four code points per token", so the tipping point
     * sits inside the range this repository itself declares: the order of the
     * two ceilings is one decimal place from reversing, in the direction the
     * sibling file considers most likely. Treat "tokens bind first" as true
     * for `r = 3` and unsettled beyond it, until `CODE_POINTS_PER_TOKEN` stops
     * being an assumption.
     *
     * Raise this only against a tier whose limits you have read, and read the
     * token limit first.
     *
     * The token column is an ESTIMATE and the request column is not. Requests
     * are counted; tokens are converted from code points at the pessimistic
     * `CODE_POINTS_PER_TOKEN` below, because nobody can count a vendor's
     * tokens without the vendor's tokenizer.
     *
     * An earlier version of this table took its per-chunk figure from the
     * corpus probe's `tokens` field, which counts BM25 index terms after
     * folding and stemming — a different quantity, and small enough to invert
     * the conclusion about which ceiling binds first. Both operands are
     * published rather than the ratio between them, so the next reader can do
     * the division and see which quantity is which: 183 BM25 index terms per
     * chunk against roughly 373 estimated model tokens. The chunk size is
     * measurable from `npm run bench:corpus` and the conversion is declared,
     * which is the most this file can honestly claim.
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
 *
 * Subtracted for EVERY model, including the ones that get `task_type` instead
 * of a prefix and so send the text untouched. Those get a window smaller than
 * the one they have, by the length of a prefix they never receive. Left that
 * way deliberately: the error is in the safe direction, and making it exact
 * would make `maxInputCodePoints` depend on the model, which is a second
 * thing to keep in step with the branch for at most a few dozen code points.
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
    const usesPrefix = model === 'gemini-embedding-2';

    async function embedParts(parts: readonly unknown[], extra: Record<string, unknown>): Promise<number[]> {
        const payload = await postJson({
            url: `${base}/models/${model}:embedContent`,
            headers: { 'x-goog-api-key': opts.apiKey },
            body: {
                model: `models/${model}`,
                content: { parts },
                output_dimensionality: dimensions,
                ...extra,
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

    async function embedOne(text: string, task: Task): Promise<number[]> {
        const prefixed = usesPrefix ? withPrefix(text, task) : text;
        return embedParts([{ text: prefixed }], usesPrefix ? {} : { task_type: TASK_TYPE[task] });
    }

    return {
        id,
        dimensions,
        maxInputCodePoints: WINDOW_TOKENS * CODE_POINTS_PER_TOKEN - PREFIX_CODE_POINTS,
        modalities: modalitiesOf(model),

        async embedDocuments(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
            if (texts.length === 0) return [];
            const vectors = await inBatches(
                texts.map((text) => () => embedOne(text, 'document')),
                concurrency,
            );
            assertShape(vectors, texts.length, dimensions, id);
            return vectors;
        },

        async embedQuery(text: string): Promise<readonly number[]> {
            const vector = await embedOne(text, 'query');
            assertShape([vector], 1, dimensions, id);
            return vector;
        },

        // Declared only when the configured model accepts images, so the
        // presence of the method and the claim in `modalities` cannot drift
        // apart — a test holds them equal for every adapter here.
        ...(modalitiesOf(model).includes('image')
            ? {
                  async embedImages(images: readonly PageImage[]): Promise<readonly (readonly number[])[]> {
                      if (images.length === 0) return [];
                      // ONE image per request, for the same reason each text
                      // gets its own: several parts in one request are fused
                      // into a SINGLE vector by this endpoint. Batching by
                      // stuffing pages into `parts` would return one vector
                      // for the whole corpus. The six-part ceiling the API
                      // documents is therefore never reached from here.
                      //
                      // No task prefix and no `task_type`: neither applies to
                      // a part that is not text.
                      const vectors = await inBatches(
                          images.map(
                              (image) => () =>
                                  embedParts(
                                      [{ inlineData: { mimeType: image.mimeType, data: image.data } }],
                                      {},
                                  ),
                          ),
                          concurrency,
                      );
                      assertShape(vectors, images.length, dimensions, id);
                      return vectors;
                  },

                  async embedImageQuery(image: PageImage): Promise<readonly number[]> {
                      const vector = await embedParts(
                          [{ inlineData: { mimeType: image.mimeType, data: image.data } }],
                          {},
                      );
                      assertShape([vector], 1, dimensions, id);
                      return vector;
                  },
              }
            : {}),
    };
}

/**
 * Which modalities a Gemini embedding model accepts.
 *
 * Derived from the CONFIGURED model, not fixed for the adapter, because
 * `opts.model` is open and the two generations differ. Verified against the
 * live endpoint for `gemini-embedding-2`: an `inlineData` part returns 200
 * and a vector, and an absent `mimeType` returns 400 naming the field.
 *
 * Anything else is text-only here, and by assumption rather than by
 * measurement — the same discipline as `qwen.ts:122`, which documents a
 * ceiling for its default model "and for no other by assumption". Claiming
 * image for an untested model would turn a capability claim into a guess,
 * and the guard that reads this would then wave through a call that fails at
 * the provider instead of at the configuration.
 */
function modalitiesOf(model: string): readonly EmbeddingModality[] {
    return model === 'gemini-embedding-2' ? (['text', 'image'] as const) : (['text'] as const);
}

type Task = 'query' | 'document';

/**
 * How the two generations are told which side of the pair they are embedding,
 * and why the adapter cannot pick one and use it everywhere.
 *
 * MEASURED against the live endpoint, same input, vectors compared component
 * by component, with a determinism control run first:
 *
 *     gemini-embedding-001   QUERY vs DOCUMENT  cos 0.4067   consumed
 *                            nothing == RETRIEVAL_QUERY      default is query
 *     gemini-embedding-2     QUERY vs DOCUMENT  IDENTICAL    accepted, discarded
 *
 * So `task_type` is a live parameter on 001 and dead weight on 2, and the
 * prefix is the reverse: on 2 it is what the model was trained to read, and
 * on 001 it is literal text that nothing strips.
 *
 * What the mismatch cost before this branch existed is the part worth
 * keeping. The adapter sent the prefix and no `task_type` to every model, so
 * a caller on 001 got BOTH halves wrong at once: the prefix went in as prose
 * (measured perturbation against the bare text, cos 0.4808), and the absent
 * `task_type` fell back to the default — which is `RETRIEVAL_QUERY`. Every
 * passage in that caller's corpus was embedded as if it were a question.
 * Nothing errored, and retrieval was simply worse.
 *
 * An invented value returns 400 naming the enum, so the two constants below
 * are the API's own and not a guess.
 */
const TASK_TYPE: Record<Task, string> = {
    query: 'RETRIEVAL_QUERY',
    document: 'RETRIEVAL_DOCUMENT',
};

/**
 * The prefixes `gemini-embedding-2` was trained to read.
 *
 * They are text, not parameters, so nothing validates them and a typo degrades
 * retrieval instead of failing. They live here, in one place, for that reason:
 * spelled out at each call site they would drift, and the drift would be
 * invisible.
 */
function withPrefix(text: string, task: Task): string {
    return task === 'query' ? asQuery(text) : asDocument(text);
}

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
 * already in flight, which have left the machine and will be paid for.
 *
 * Without the shared flag the first rejection killed only the worker that saw
 * it: `Promise.all` handed the error to the caller while the others kept
 * draining the queue, paying for results nobody would read — hundreds of
 * requests made after the caller gave up, and if the cause was a rate limit,
 * aimed at an endpoint that had just said to stop. Nothing announced it: the
 * later rejections reach the handler `Promise.all` attached to every worker at
 * call time, so they are absorbed rather than surfacing as unhandled. Measured
 * under `--unhandled-rejections=throw` with four staggered failures: no
 * unhandled rejection, exit 0.
 *
 * That overshoot is `limit - 1`, and it is measured rather than reasoned:
 * across twelve configurations — concurrency 4 and 8, failure at the first,
 * fourth and eleventh call, with and without a delay before each response —
 * the count was exactly `limit - 1` every time. `failed` is set in the same
 * microtask as the rejection, so every sibling reads it before its next turn
 * of the loop; there is no window in which one of them picks up another task.
 * The test pins the exact number, not a tolerance.
 *
 * Cancelling the in-flight calls would mean threading an `AbortSignal` from
 * here into every request, which is worth doing the day something needs to
 * cancel an index build on purpose.
 */
async function inBatches<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
    const out = new Array<T>(tasks.length);
    let next = 0;
    let failed = false;

    async function worker(): Promise<void> {
        for (;;) {
            if (failed) return;
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
