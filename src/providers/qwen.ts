/**
 * @fileoverview Qwen embeddings, through Alibaba's DashScope.
 *
 * The third batching story in three adapters. OpenAI takes an array and
 * returns one vector per element; Gemini fuses several parts into one vector
 * and so needs a request per input; this one takes an array with a documented
 * ceiling per call, so a corpus is split into runs of that size.
 *
 * It is also the only one of the three with a first-class parameter for the
 * asymmetry — `text_type`, set to `query` or `document`. No prefix to write
 * into the text and no convention to get subtly wrong.
 */

import type { EmbeddingProvider } from '../embedding.js';
import { postJson, assertShape, EmbeddingProviderError, requirePositiveInteger } from './http.js';

/**
 * The batch ceiling, or an error naming what to pass.
 *
 * A model this adapter has never heard of is not a reason to refuse the model
 * — new ones ship faster than releases do — but inheriting the default's
 * ceiling would send twenty texts to a service that documents ten, and the
 * caller would read the rejection as a bug in this library.
 */
function resolveBatchSize(requested: number | undefined, model: string): number {
    if (requested !== undefined) return requested;
    if (model === DEFAULT_MODEL) return DEFAULT_BATCH;
    throw new Error(
        `qwenProvider: model "${model}" is not the one this adapter knows the batch ceiling of ` +
            `("${DEFAULT_MODEL}"), so pass \`batchSize\` explicitly`,
    );
}

export interface QwenOptions {
    readonly apiKey: string;
    /** Defaults to `qwen3.7-text-embedding`. */
    readonly model?: string;
    /** 256 to 2560. Defaults to 1024, which is the model's own default. */
    readonly dimensions?: number;
    /**
     * The service endpoint. Which one is the caller's business, not this
     * library's — but the failure mode is bad enough to document here.
     *
     * A DashScope API KEY BELONGS TO ONE REGION, and only that region's host
     * accepts it. The provider documents the hosts by region:
     *
     *     cn-beijing        https://dashscope.aliyuncs.com/...     (the default here)
     *     ap-southeast-1    https://dashscope-intl.aliyuncs.com/...
     *     us-east-1         https://dashscope-us.aliyuncs.com/...
     *     cn-hongkong       https://cn-hongkong.dashscope.aliyuncs.com/...
     *
     * Frankfurt and Tokyo have no classic host and are reached only at the
     * workspace address, `{workspaceId}.{region}.maas.aliyuncs.com`. The model
     * catalogue differs by region too, so a model id that resolves in one can
     * 404 in another.
     *
     * Measured on 2026-09-13 with a valid `ap-southeast-1` key: the mainland
     * host answers `401 InvalidApiKey` — naming the wrong culprit, because the
     * key is fine and the host is wrong — while the same key against the
     * international host returned a 1024-wide vector. Whoever meets that 401
     * starts by regenerating a key that was never the problem, so the error
     * this adapter raises carries the rule.
     *
     * This is the whole endpoint, not a prefix: a base pointing somewhere else
     * (a chat deployment, say) replaces the path as well, and the call 404s.
     */
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly fetch?: typeof globalThis.fetch;
    /**
     * Texts per call.
     *
     * The default is 20, which is the documented ceiling for the default
     * model — not a margin under it. The number is written here rather than
     * alluded to because a comment that says "stays under the documented
     * ceiling" without naming the ceiling cannot be checked by the next
     * reader, and this one was sitting exactly on it.
     *
     * It is also model-specific and this adapter does NOT know it for a model
     * it has not seen: `text-embedding-v4`, for one, documents 10. Passing a
     * `model` therefore means passing a `batchSize` too, and the adapter
     * refuses rather than guessing — the same rule the OpenAI adapter applies
     * to vector width, for the same reason. A batch over the ceiling fails
     * loudly, which is the good case; the bad case is a ceiling that silently
     * truncates the run.
     */
    readonly batchSize?: number;
}

const MAINLAND_URL =
    'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';
/**
 * Turns a 401 against the default host into one that states the rule.
 *
 * A key belongs to one region and the wrong host rejects a perfectly good key
 * as `InvalidApiKey`. Measured: a valid `ap-southeast-1` key gets that 401
 * from the mainland host and a 1024-wide vector from the international one.
 * Without this the message sends the reader to regenerate a key that was never
 * the problem — the failure looks solved by the one action that cannot solve
 * it.
 *
 * It states the rule and lists the hosts rather than guessing a region: which
 * one is right depends on where the account was created, which this library
 * has no way to know and no business choosing.
 */
function wrongHostHint(cause: unknown, url: string): unknown {
    if (!(cause instanceof EmbeddingProviderError) || cause.status !== 401 || url !== MAINLAND_URL) {
        return cause;
    }
    return new EmbeddingProviderError(
        cause.providerId,
        cause.status,
        `${cause.message} — a DashScope key works only against its own region's host, and this is ` +
            `the cn-beijing one. Pass baseUrl for the region the key was created in: ` +
            `dashscope-intl.aliyuncs.com (ap-southeast-1), dashscope-us.aliyuncs.com (us-east-1), ` +
            `cn-hongkong.dashscope.aliyuncs.com (cn-hongkong), each with the path this default uses.`,
    );
}

const DEFAULT_DIMENSIONS = 1024;
const DEFAULT_MODEL = 'qwen3.7-text-embedding';
/** Documented ceiling for `DEFAULT_MODEL`, and for no other model by assumption. */
const DEFAULT_BATCH = 20;

/**
 * This model's window is enormous — published at 128k tokens — which makes the
 * chunk guard effectively inert for it. That is fine and worth writing down:
 * the guard protects against a chunk ceiling configured far too large, not
 * against this provider, and it is the adapter for a narrower model that makes
 * it earn its place.
 */
const CODE_POINTS_PER_TOKEN = 3;
const WINDOW_TOKENS = 128_000;

export function qwenProvider(opts: QwenOptions): EmbeddingProvider {
    const model = opts.model ?? DEFAULT_MODEL;
    const dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
    const id = `qwen:${model}:${dimensions}`;
    const url = opts.baseUrl ?? MAINLAND_URL;
    const batchSize = requirePositiveInteger(resolveBatchSize(opts.batchSize, model), 'batchSize');

    async function embedRun(
        texts: readonly string[],
        textType: 'query' | 'document',
    ): Promise<number[][]> {
        const payload = await postJson({
            url,
            headers: { authorization: `Bearer ${opts.apiKey}` },
            body: {
                model,
                input: { texts },
                parameters: { dimension: dimensions, text_type: textType, output_type: 'dense' },
            },
            providerId: id,
            ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
            ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
        }).catch((cause: unknown) => {
            throw wrongHostHint(cause, url);
        });

        return readVectors(payload, texts.length, id);
    }

    async function embedAll(
        texts: readonly string[],
        textType: 'query' | 'document',
    ): Promise<readonly (readonly number[])[]> {
        if (texts.length === 0) return [];
        const out: number[][] = [];
        // Sequential, and that is a decision rather than an oversight. The
        // Gemini adapter runs its calls concurrently because it has no choice
        // about making six hundred of them, and it could size the ceiling
        // against limits this repository has read. Here a corpus is thirty-two
        // calls, the published per-account limits were not read, and guessing
        // a concurrency for someone else's account trades a slow index for
        // a rate limit they did not ask for. Named debt: read the limits,
        // then reuse the Gemini adapter's bounded runner.
        for (let start = 0; start < texts.length; start += batchSize) {
            out.push(...(await embedRun(texts.slice(start, start + batchSize), textType)));
        }
        assertShape(out, texts.length, dimensions, id);
        return out;
    }

    return {
        id,
        dimensions,
        maxInputCodePoints: WINDOW_TOKENS * CODE_POINTS_PER_TOKEN,
        embedDocuments: (texts) => embedAll(texts, 'document'),
        async embedQuery(text: string): Promise<readonly number[]> {
            const [vector] = await embedAll([text], 'query');
            return vector!;
        },
    };
}

/**
 * Reads the vectors, ordered by the index the service reports.
 *
 * Same reasoning as the OpenAI adapter: the response carries `text_index` per
 * entry, and trusting arrival order would hold until it did not, at which
 * point every chunk in the run would carry a neighbour's vector with nothing
 * raising.
 */
function readVectors(payload: unknown, expected: number, providerId: string): number[][] {
    const embeddings = (payload as { output?: { embeddings?: unknown } }).output?.embeddings;
    if (!Array.isArray(embeddings)) {
        throw new EmbeddingProviderError(providerId, undefined, 'response has no `output.embeddings` array');
    }

    const out = new Array<number[] | undefined>(expected);
    for (const entry of embeddings) {
        const index = (entry as { text_index?: unknown }).text_index;
        const embedding = (entry as { embedding?: unknown }).embedding;
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= expected) {
            throw new EmbeddingProviderError(
                providerId,
                undefined,
                `response entry has text_index ${String(index)}, outside 0..${expected - 1}`,
            );
        }
        if (!Array.isArray(embedding)) {
            throw new EmbeddingProviderError(providerId, undefined, `entry ${index} has no \`embedding\` array`);
        }
        if (out[index] !== undefined) {
            throw new EmbeddingProviderError(providerId, undefined, `response repeats text_index ${index}`);
        }
        out[index] = embedding as number[];
    }

    const missing = out.findIndex((v) => v === undefined);
    if (missing !== -1) {
        throw new EmbeddingProviderError(providerId, undefined, `response has no entry for text_index ${missing}`);
    }
    return out as number[][];
}
