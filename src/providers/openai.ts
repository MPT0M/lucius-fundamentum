/**
 * @fileoverview OpenAI embeddings.
 *
 * The simplest of the three: one endpoint, native batching, and no asymmetry
 * to honour — the model absorbed the query/document distinction during
 * training and the API offers nothing to set. `embedQuery` therefore does
 * exactly what `embedDocuments` does with one text, and says so rather than
 * leaving the reader to wonder what was forgotten.
 *
 * The simplicity has one edge, declared because it is the only one of the
 * three batching stories with no ceiling in it: this adapter sends every text
 * in a single request. That is one call for the six hundred chunks of this
 * repository's corpus and it is the whole point — but the endpoint does have
 * per-request limits on inputs and on tokens, and a corpus large enough meets
 * them. The failure is loud (the API rejects the request) rather than silent,
 * which is why this ships as a named debt instead of a guess at the number:
 * splitting on a ceiling nobody has read would be the Qwen adapter's mistake
 * in a different file.
 */

import type { EmbeddingProvider } from '../embedding.js';
import { postJson, assertShape, EmbeddingProviderError } from './http.js';

export interface OpenAiOptions {
    readonly apiKey: string;
    /** Defaults to `text-embedding-3-small`. */
    readonly model?: string;
    /**
     * Truncates the vector. The model is trained so that a prefix of the
     * vector stays usable, so this trades accuracy for storage without
     * retraining. Omit to get the model's native width.
     */
    readonly dimensions?: number;
    /** Overridable for a proxy or a compatible gateway. */
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly fetch?: typeof globalThis.fetch;
}

const NATIVE_DIMENSIONS: Readonly<Record<string, number>> = {
    'text-embedding-3-small': 1536,
    'text-embedding-3-large': 3072,
};

/**
 * Code points per token, deliberately pessimistic.
 *
 * The window is published in tokens and nobody can count those without the
 * provider's tokenizer. Portuguese runs near four code points per token for
 * prose, and less for text dense in punctuation and numbers — which is what a
 * legal corpus is. Three is the conservative end: it makes the guard refuse
 * slightly early rather than let a chunk through to be truncated in silence,
 * and refusing early is the failure that announces itself.
 *
 * It is also the one number here that no test in this repository can settle,
 * and it is load-bearing: both window guards compare against it, so a ratio
 * that is generous for some text lets through a chunk the provider truncates
 * in silence — the exact failure the guards exist to refuse. Named debt, with
 * the measurement within reach: this endpoint returns `usage.prompt_tokens`
 * for the text it was sent, so one real call with a chunk near the ceiling
 * turns this constant from an assumption into a calibration. See
 * `countTokens` in the provider contract.
 */
const CODE_POINTS_PER_TOKEN = 3;
const WINDOW_TOKENS = 8192;

/**
 * The vector width, or an error naming what to pass.
 *
 * A function rather than a check in place because the value is closed over by
 * both embedding methods, and a narrowing that only holds in the enclosing
 * scope leaves them typed as possibly-undefined. Returning `number` puts the
 * guarantee in the type, where the closures can see it.
 *
 * A model this adapter has never heard of is not a reason to refuse — new ones
 * ship faster than releases do — but guessing its width would produce vectors
 * of one size against an index built for another, which fails far from here.
 */
function resolveDimensions(requested: number | undefined, model: string): number {
    if (requested !== undefined) return requested;
    const native = NATIVE_DIMENSIONS[model];
    if (native !== undefined) return native;
    throw new Error(
        `openAiProvider: model "${model}" is not one this adapter knows the width of ` +
            `(${Object.keys(NATIVE_DIMENSIONS).join(', ')}), so pass \`dimensions\` explicitly`,
    );
}

export function openAiProvider(opts: OpenAiOptions): EmbeddingProvider {
    const model = opts.model ?? 'text-embedding-3-small';
    const dimensions = resolveDimensions(opts.dimensions, model);
    const id = `openai:${model}:${dimensions}`;
    const url = `${opts.baseUrl ?? 'https://api.openai.com/v1'}/embeddings`;

    async function embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
        if (texts.length === 0) return [];
        const payload = await postJson({
            url,
            headers: { authorization: `Bearer ${opts.apiKey}` },
            body: {
                model,
                input: texts,
                encoding_format: 'float',
                ...(opts.dimensions === undefined ? {} : { dimensions: opts.dimensions }),
            },
            providerId: id,
            ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
            ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
        });

        const vectors = readVectors(payload, texts.length, id);
        assertShape(vectors, texts.length, dimensions, id);
        return vectors;
    }

    return {
        id,
        dimensions,
        maxInputCodePoints: WINDOW_TOKENS * CODE_POINTS_PER_TOKEN,
        // The embeddings endpoint this adapter speaks to takes strings. Image
        // input would be a different endpoint and a different request shape,
        // neither of them written here.
        modalities: ['text'],
        embedDocuments: embed,
        async embedQuery(text: string): Promise<readonly number[]> {
            // No prefix, no parameter, no separate call: this provider has no
            // notion of query versus passage. The method exists because the
            // interface has it, and doing anything clever here would be
            // inventing a convention the vendor does not have.
            const [vector] = await embed([text]);
            return vector!;
        },
    };
}

/**
 * Reads the vectors out of the response, ordered by the index the API reports
 * rather than by array position.
 *
 * The documented contract is that each entry carries its own `index`, and
 * trusting arrival order instead would be correct until the day it is not —
 * at which point every chunk would hold a neighbour's vector and nothing would
 * raise.
 */
function readVectors(payload: unknown, expected: number, providerId: string): number[][] {
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) {
        throw new EmbeddingProviderError(providerId, undefined, 'response has no `data` array');
    }

    const out = new Array<number[] | undefined>(expected);
    for (const entry of data) {
        const index = (entry as { index?: unknown }).index;
        const embedding = (entry as { embedding?: unknown }).embedding;
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= expected) {
            throw new EmbeddingProviderError(
                providerId,
                undefined,
                `response entry has index ${String(index)}, outside 0..${expected - 1}`,
            );
        }
        if (!Array.isArray(embedding)) {
            throw new EmbeddingProviderError(providerId, undefined, `entry ${index} has no \`embedding\` array`);
        }
        if (out[index] !== undefined) {
            throw new EmbeddingProviderError(providerId, undefined, `response repeats index ${index}`);
        }
        out[index] = embedding as number[];
    }

    const missing = out.findIndex((v) => v === undefined);
    if (missing !== -1) {
        throw new EmbeddingProviderError(providerId, undefined, `response has no entry for index ${missing}`);
    }
    return out as number[][];
}
