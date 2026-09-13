/**
 * @fileoverview The embedding provider contract and the guard that keeps a
 * chunk from being truncated without anyone noticing.
 *
 * Two adapters are meant to exist from the start — one interface with a single
 * implementation is not an interface, it is that implementation with extra
 * indirection. This file holds neither of them: it holds the shape they have to
 * fit and a deterministic provider that lets the whole dense arm be tested with
 * no network, no key and no cost.
 */

import { countCodePoints } from './unicode.js';
import { normalize } from './vector.js';

export interface EmbeddingProvider {
    /** Travels into the artifact, so an index says which provider produced it. */
    readonly id: string;
    readonly dimensions: number;
    /**
     * The longest input the provider accepts, in code points.
     *
     * Providers publish their limit in tokens, which nobody can count without
     * the provider's own tokenizer. The conversion factor is the adapter's
     * business and it is declared there, conservatively: this number is what
     * the guard compares against, and a factor that is too generous turns the
     * guard into decoration.
     */
    readonly maxInputCodePoints: number;
    /**
     * Embeds passages to be searched IN.
     *
     * Two methods and not one with a flag, because the two are genuinely
     * different calls for most providers and a flag is forgettable: an adapter
     * that ignored it would work, return vectors, and retrieve worse than it
     * should, with nothing to show for it. Two methods cannot be half
     * implemented.
     *
     * The shape follows the convention the ecosystem already uses, so an
     * adapter author recognizes it without reading this. The types carry the
     * asymmetry too: there are many documents and one query.
     */
    embedDocuments(texts: readonly string[]): Promise<readonly (readonly number[])[]>;

    /**
     * Embeds the text to be searched WITH.
     *
     * Questions and passages are different kinds of text — short and
     * interrogative against long and declarative — and a model that embeds
     * both identically tends to place questions near other questions rather
     * than near the passages that answer them. Providers offer a way to say
     * which is which, each in its own syntax: a prefix written into the text,
     * or a parameter beside it.
     *
     * The published gains are modest where they are published at all, around
     * one to five percent for the families that measure it, and one of the
     * three adapters this library ships has no such notion because its
     * training absorbed the asymmetry. It is here anyway because a provider's
     * own documentation prescribes the asymmetric pair for retrieval, and
     * without this method an adapter has no way to obey.
     */
    embedQuery(text: string): Promise<readonly number[]>;

    /** Exact token count, when the provider offers one. */
    countTokens?(text: string): Promise<number>;
}

/**
 * Rejects, before any call is paid for, a chunking configuration whose ceiling
 * already exceeds what the provider accepts.
 *
 * This is the cheap half of the guard and it catches the obvious case early.
 * It is NOT sufficient, and the reason is that the parameter is a budget, not
 * a bound: a single sentence longer than the ceiling is emitted whole rather
 * than cut in half, so a configuration that passes here can still produce a
 * chunk the provider would truncate in silence.
 *
 * Measured by `npm run bench:corpus` on the corpus in this repository: 2 of
 * 636 chunks exceed `maxChunkCodePoints`. Rare, and that is the point — a
 * failure that fires twice in six hundred is one nobody finds by trying the
 * library out, and the tail of those two chunks would simply be absent from
 * the index with nothing to show for it.
 */
export function assertChunkCeilingFits(maxChunkCodePoints: number, provider: EmbeddingProvider): void {
    if (maxChunkCodePoints <= provider.maxInputCodePoints) return;
    throw new Error(
        `chunk ceiling ${maxChunkCodePoints} code points exceeds the window of provider ` +
            `${provider.id}: ${provider.maxInputCodePoints}`,
    );
}

/**
 * Rejects the chunk that actually does not fit, naming it and both sizes.
 *
 * This is the half that matters. Silent truncation is the failure this library
 * exists to refuse: the provider returns a vector, the vector is plausible, the
 * search works, and the tail of every long chunk is simply absent from the
 * index with no symptom at all. "A chunk did not fit" would not be debuggable
 * either, so the message carries which chunk and by how much.
 */
export function assertChunksFit(
    chunks: readonly { readonly id: string; readonly text: string }[],
    provider: EmbeddingProvider,
): void {
    for (const chunk of chunks) {
        const size = countCodePoints(chunk.text);
        if (size <= provider.maxInputCodePoints) continue;
        throw new Error(
            `chunk ${chunk.id}: ${size} code points, window of provider ${provider.id}: ${provider.maxInputCodePoints}`,
        );
    }
}

/**
 * A provider that embeds without leaving the machine.
 *
 * It exists so the dense arm — indexing, cosine, the artifact, the fusion that
 * comes after — is testable end to end with no key, no network and no cost,
 * which is the only way those tests run in CI and on a contributor's laptop.
 *
 * The vectors carry no meaning: they are a hash of the text spread over the
 * dimensions. Two identical texts embed identically and two different texts
 * almost never collide, which is everything the mechanics need. What it cannot
 * do is tell whether "doença" is near "condições de saúde" — that is the whole
 * point of a real provider, and no test here may pretend otherwise.
 */
export function deterministicProvider(dimensions = 32): EmbeddingProvider {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
        throw new Error(`deterministicProvider: dimensions must be a positive integer, received ${dimensions}`);
    }
    return {
        id: `deterministic-${dimensions}`,
        dimensions,
        // Large enough never to be the thing under test here; the guard has its
        // own fixtures with a deliberately small window.
        maxInputCodePoints: 1_000_000,
        async embedDocuments(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
            return texts.map((text) => normalize(spread(text, dimensions)));
        },
        // No asymmetry to honour: a hash has no notion of question or passage.
        // Identical text still embeds identically through either door, which
        // is what the mechanics under test rely on.
        async embedQuery(text: string): Promise<readonly number[]> {
            return normalize(spread(text, dimensions));
        },
    };
}

/**
 * Spreads a text over `dimensions` components using the same FNV-1a the
 * content hash uses, seeded per component so the components differ.
 *
 * A constant is added so no component can come out exactly zero for every
 * dimension at once, which would make the vector unnormalizable and turn an
 * empty string into a crash in a place nobody would look.
 */
function spread(text: string, dimensions: number): number[] {
    const out = new Array<number>(dimensions);
    for (let d = 0; d < dimensions; d += 1) {
        let hash = 2166136261 ^ (d * 16777619);
        for (const ch of text) {
            hash ^= ch.codePointAt(0)!;
            hash = Math.imul(hash, 16777619);
        }
        // Into [-1, 1], plus a small offset that survives an empty text.
        out[d] = (hash >>> 0) / 2147483648 - 1 + 1e-3;
    }
    return out;
}
