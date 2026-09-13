/**
 * @fileoverview The one thing the three adapters share: how a failed call
 * becomes an error someone can act on.
 *
 * Everything else about them differs — endpoint, auth header, body shape,
 * where the vector sits in the response, how the query is marked as a query.
 * Pretending otherwise is how an adapter layer ends up with a shape that fits
 * one vendor and gets bent for the rest.
 */

/** Named so a caller can tell a provider failure from a bug in this library. */
export class EmbeddingProviderError extends Error {
    constructor(
        readonly providerId: string,
        readonly status: number | undefined,
        message: string,
    ) {
        super(message);
        this.name = 'EmbeddingProviderError';
    }
}

export interface PostOptions {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
    readonly providerId: string;
    /** Milliseconds. A hung request is worse than a failed one. */
    readonly timeoutMs?: number;
    /** Injected in tests; defaults to the global. */
    readonly fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Posts JSON and returns the parsed response, or throws with enough to debug.
 *
 * The body of a failed response is included, truncated. Providers put the real
 * reason there — quota, wrong model id, malformed field — and an error that
 * says only "429" sends whoever reads it to the dashboard instead of to the
 * sentence explaining what happened.
 *
 * The excerpt is capped because a provider answering with an HTML error page
 * would otherwise paste a whole document into a log line.
 */
export async function postJson(opts: PostOptions): Promise<unknown> {
    const doFetch = opts.fetch ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
        throw new EmbeddingProviderError(
            opts.providerId,
            undefined,
            'no fetch available: pass one in, or run somewhere that has it globally',
        );
    }

    let response: Response;
    let text: string;
    try {
        response = await doFetch(opts.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...opts.headers },
            body: JSON.stringify(opts.body),
            signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        // Reading the body belongs inside the same guard as sending the
        // request, because the timeout covers both: the signal aborts the
        // whole exchange, not just the headers, so a large response arriving
        // slowly fails HERE rather than above. Left outside, that failure
        // escaped as a raw network exception and the caller lost the provider
        // id and status this class exists to carry.
        text = await response.text();
    } catch (cause) {
        // A timeout and a DNS failure arrive here the same way, and the caller
        // needs to know which: one is worth retrying now, the other is not.
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new EmbeddingProviderError(opts.providerId, undefined, `request failed: ${reason}`);
    }

    if (!response.ok) {
        throw new EmbeddingProviderError(
            opts.providerId,
            response.status,
            `HTTP ${response.status}: ${excerpt(text)}`,
        );
    }

    try {
        return JSON.parse(text) as unknown;
    } catch {
        // A 200 carrying something that is not JSON usually means a proxy or a
        // login page answered instead of the provider.
        throw new EmbeddingProviderError(
            opts.providerId,
            response.status,
            `response was not JSON: ${excerpt(text)}`,
        );
    }
}

const EXCERPT_MAX = 300;

function excerpt(text: string): string {
    const flat = text.replace(/\s+/gu, ' ').trim();
    return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX)}…`;
}

/**
 * Refuses anything that is not a whole number above zero, and says which
 * option was wrong.
 *
 * `Math.max(1, value)` reads like a floor and is not one: `Math.max(1, NaN)`
 * is `NaN`, and `NaN` reaching a batch size or a worker count produces an
 * empty loop, a result array full of holes, and a `TypeError` thrown far from
 * the option that caused it. `Number(process.env.CONCURRENCY)` on an unset
 * variable is all it takes. The rest of this library already refuses at the
 * edge — `unpackVectors` and `deterministicProvider` both check
 * `Number.isInteger` — and the adapters were the one place that did not.
 */
export function requirePositiveInteger(value: number, optionName: string): number {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${optionName} must be a whole number of at least 1, got ${String(value)}`);
    }
    return value;
}

/**
 * Checks that a provider returned as many vectors as it was given inputs, and
 * that each has the promised width.
 *
 * Shared because all three can fail this way and the consequence is identical:
 * one vector fewer shifts every chunk after the gap onto its neighbour's
 * vector, and a wrong width makes the cosine a dimension mismatch later, far
 * from the call that caused it.
 */
export function assertShape(
    vectors: readonly (readonly number[])[],
    expectedCount: number,
    dimensions: number,
    providerId: string,
): void {
    if (vectors.length !== expectedCount) {
        throw new EmbeddingProviderError(
            providerId,
            undefined,
            `returned ${vectors.length} vectors for ${expectedCount} inputs`,
        );
    }
    for (let i = 0; i < vectors.length; i += 1) {
        const width = vectors[i]!.length;
        if (width !== dimensions) {
            throw new EmbeddingProviderError(
                providerId,
                undefined,
                `returned a ${width}-dimension vector at position ${i}, but ${dimensions} was requested`,
            );
        }
    }
}
