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

import type { PageImage } from './chunker.js';
import { countCodePoints } from './unicode.js';
import { normalize } from './vector.js';

/**
 * A kind of input an embedding provider can be asked to vectorize.
 *
 * A closed union rather than `string`, so that adding a kind is a change the
 * compiler shows every adapter, and a typo in an adapter is caught where it
 * is written instead of being read later as "this provider cannot do that".
 */
export type EmbeddingModality = 'text' | 'image';

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
     * What this provider, configured as it is, can be asked to embed.
     *
     * REQUIRED, and the omission is why. An optional field defaulting to
     * text-only would let an adapter that genuinely accepts images be treated
     * as if it did not, because its author never learned the field existed —
     * a capability lost in silence, which is the failure the field is here to
     * prevent. Required, the compiler asks every adapter the question once.
     *
     * The capability belongs to the ADAPTER AS CONFIGURED, not to a global
     * list of model names. `opts.model` is open, and the same model is served
     * under different identifiers by different hosts, so a name allowlist
     * would refuse legitimate deployments. What an adapter can answer for is
     * which of ITS OWN models do what — the precedent is `qwen.ts:122`,
     * "documented ceiling for the DEFAULT_MODEL, and for no other by
     * assumption".
     *
     * `'text'` is in every adapter's list. Anything beyond it is a claim the
     * adapter is making about the model it was handed.
     */
    readonly modalities: readonly EmbeddingModality[];
    /**
     * Embeds passages to be searched IN.
     *
     * MAGNITUDE IS NOT PART OF THIS CONTRACT, even though every implementation
     * currently satisfies the stronger promise. Measured on 2026-09-13:
     * `gemini-embedding-2` at 1536 dimensions and `qwen3.7-text-embedding` at
     * 1024 both return vectors of norm 1.0000, and the deterministic provider
     * normalizes by construction.
     *
     * The contract stays silent anyway, for two reasons. A vendor can change
     * this without changing anything a test here would notice — one of them
     * documents not normalizing below its full width, which is not what the
     * measurement found, and a promise that rests on a vendor's current
     * behaviour is a promise this library cannot keep. And an adapter written
     * by someone else has no reason to inherit it.
     *
     * Nothing inside the library depends on the difference: indexing and
     * querying both normalize unconditionally, and normalizing twice changes
     * nothing. It is written down for the caller who uses a provider directly,
     * compares two vectors by dot product, and would otherwise get a number
     * that is a cosine only by the vendor's good manners.
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

    /**
     * Embeds already-rasterized pages, one vector per page.
     *
     * Present exactly when `modalities` includes `'image'`, and the two are
     * checked against each other for every adapter this package ships. A
     * third-party adapter that declares the modality without implementing
     * this gets a named error from `embedImagesChecked` rather than a
     * `TypeError` from calling undefined.
     *
     * Optional rather than required for the same reason `embedDocuments` is
     * not: most embedding endpoints take strings and nothing else, and
     * forcing every adapter to write a method that throws would put the
     * refusal in three places instead of in the declaration.
     */
    embedImages?(images: readonly PageImage[]): Promise<readonly (readonly number[])[]>;

    /**
     * Embeds an image used as the QUERY: photograph a diagram, find the
     * material that covers it.
     *
     * Separate from `embedImages` for the same reason `embedQuery` is
     * separate from `embedDocuments`: providers ask to be told which side of
     * the pair they are embedding, and a flag is forgettable in a way two
     * methods are not. Present under the same rule — exactly when
     * `modalities` includes `'image'`.
     */
    embedImageQuery?(image: PageImage): Promise<readonly number[]>;

    /**
     * Exact token count, when the provider offers one.
     *
     * NO ADAPTER IMPLEMENTS THIS YET, so nothing exercises it and the optional
     * marker is currently load-bearing. It is declared because a ratio is the
     * wrong instrument for a ceiling: the only way to know a text fits is to
     * count it with the tokenizer that will read it.
     *
     * The conversion happens in the ADAPTER, not in the guards below, and in
     * the other direction: each adapter turns its published window in tokens
     * into `maxInputCodePoints` by multiplying by a pessimistic constant, and
     * the guards then compare code points against code points. So the estimate
     * is made once, far from the comparison, and every guard inherits it
     * without any of them naming it.
     *
     * The cheapest way in is already on the wire — OpenAI returns
     * `usage.prompt_tokens` on every embedding response, the vendor's own
     * count for the exact text that was sent, and the adapter throws it away.
     * Reading it would implement this method for one provider and calibrate
     * the ratio for the others at the same time.
     */
    countTokens?(text: string): Promise<number>;
}

/**
 * What went wrong with an embedding call, as a FIELD rather than a sentence.
 *
 * A caller that has to match a substring against `message` to know whether a
 * retry is worth making is coupled to prose that changes without notice. This
 * package refuses that coupling for a provider's errors and it would be odd to
 * accept it for its own.
 *
 * `input-too-large` is deliberately NOT in `ProviderFailure['reason']` over in
 * `attribute`: it is checked BEFORE the network is called, it would fail on
 * every call with the same input, and degrading there would turn a caller's
 * configuration error into permanent silent behaviour. It throws.
 */
export type EmbeddingCheckReason =
    | 'input-too-large'
    | 'bad-count'
    | 'bad-dimensions'
    | 'modality-unsupported';

/** Named so a caller can classify without reading the message. */
export class EmbeddingCheckError extends Error {
    constructor(
        readonly reason: EmbeddingCheckReason,
        message: string,
    ) {
        super(message);
        this.name = 'EmbeddingCheckError';
    }
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
    throw new EmbeddingCheckError(
        'input-too-large',
        `chunk ceiling ${maxChunkCodePoints} code points exceeds the window of provider ` +
            `${provider.id}: ${provider.maxInputCodePoints}`,
    );
}

/**
 * Rejects, before any call is paid for, asking a provider for a modality it
 * did not declare.
 *
 * Refusing loudly is the whole point. The quiet alternatives are both worse
 * than an error: dropping the pages leaves an index that is missing exactly
 * the material the caller went to the trouble of rasterizing, and sending
 * them anyway produces a provider error whose message is about a request
 * shape rather than about a configuration choice the caller made.
 *
 * Sits beside `assertChunkCeilingFits` because it is the same kind of check —
 * asked once, before the network, about a mismatch that would fail on every
 * call with this configuration.
 */
export function assertModalitySupported(
    modality: EmbeddingModality,
    provider: EmbeddingProvider,
    howMany: number,
): void {
    if (provider.modalities.includes(modality)) return;
    throw new EmbeddingCheckError(
        'modality-unsupported',
        `provider ${provider.id} declares [${provider.modalities.join(', ')}] and was asked to embed ` +
            `${howMany} ${modality} input${howMany === 1 ? '' : 's'}`,
    );
}

/**
 * Embeds pages through the provider, with the same count and dimension checks
 * the text path gets.
 *
 * The checks are not duplicated for symmetry. A provider that returns one
 * vector fewer than it was given pages would shift every page's vector onto
 * the next page — the index would work, rank, and be wrong everywhere, with
 * nothing to show for it. That is the failure `bad-count` exists for, and it
 * does not care which modality produced the list.
 */
export async function embedImagesChecked(
    images: readonly PageImage[],
    provider: EmbeddingProvider,
): Promise<readonly (readonly number[])[]> {
    if (provider.embedImages === undefined) {
        throw new EmbeddingCheckError(
            'modality-unsupported',
            `provider ${provider.id} declares [${provider.modalities.join(', ')}] but implements no ` +
                'embedImages. An adapter that claims the modality has to provide the method.',
        );
    }
    const raw = await provider.embedImages(images);
    if (raw.length !== images.length) {
        throw new EmbeddingCheckError(
            'bad-count',
            `provider ${provider.id} returned ${raw.length} vectors for ${images.length} images; ` +
                'exactly one per image is needed, in order',
        );
    }
    return raw.map((vector, index) => {
        if (vector.length !== provider.dimensions) {
            throw new EmbeddingCheckError(
                'bad-dimensions',
                `provider ${provider.id} returned a ${vector.length}-dimension vector for image ${index}, ` +
                    `but reports ${provider.dimensions} dimensions`,
            );
        }
        return normalize([...vector]);
    });
}

/**
 * Rejects the item that actually does not fit, naming it and both sizes.
 *
 * The items are chunks when the index calls, and clauses of an answer when
 * the attributor does. The message names whatever id it was handed and adds
 * no noun of its own: `chunk clause 3: ...` reads like a bug in the caller.
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
        throw new EmbeddingCheckError(
            'input-too-large',
            `${chunk.id}: ${size} code points, window of provider ${provider.id}: ${provider.maxInputCodePoints}`,
        );
    }
}

/**
 * Embeds several texts through `embedDocuments` and hands back unit vectors,
 * refusing an answer that does not match the question.
 *
 * Two layers call this, and they must check the same things. The index embeds
 * its chunks here; the attributor embeds the candidate passages and the clauses
 * it cannot separate lexically. A second implementation would have to repeat
 * three guarantees, and repeating them is how one of them goes missing.
 *
 * **Count.** A provider that silently returns fewer vectors than inputs would
 * shift every subsequent text onto its neighbour's vector — an off-by-one with
 * no exception and no symptom except results that are subtly wrong forever.
 *
 * **Dimension.** A vector of the wrong width is a provider disagreeing with its
 * own `dimensions`, and the error names which input, because "a vector was the
 * wrong size" is not debuggable.
 *
 * **Normalization.** The caller gets unit vectors, so a dot product IS the
 * cosine (`vector.ts`). This is what makes the index's hot loop a dot product
 * instead of a cosine — no square root per chunk on every search, for a value
 * that never changes — and it is what keeps a caller who compares fresh vectors
 * from ordering by vector length without noticing.
 */
export async function embedDocumentsChecked(
    texts: readonly string[],
    provider: EmbeddingProvider,
): Promise<readonly (readonly number[])[]> {
    const raw = await provider.embedDocuments(texts);
    if (raw.length !== texts.length) {
        throw new EmbeddingCheckError(
            'bad-count',
            `provider ${provider.id} returned ${raw.length} vectors for ${texts.length} inputs; ` +
                'exactly one per input is needed, in order',
        );
    }
    return raw.map((v, i) => {
        if (v.length !== provider.dimensions) {
            throw new EmbeddingCheckError(
                'bad-dimensions',
                `provider ${provider.id} returned a ${v.length}-dimension vector for input ${i}, ` +
                    `but reports ${provider.dimensions} dimensions`,
            );
        }
        return normalize([...v]);
    });
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
        // Text only. A fake that claimed 'image' would let a test exercise the
        // image path without any image ever being encoded, which is the kind
        // of green this provider exists to refuse.
        modalities: ['text'],
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
