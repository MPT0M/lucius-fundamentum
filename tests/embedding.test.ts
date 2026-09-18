import { describe, it, expect } from 'vitest';
import {
    assertChunkCeilingFits,
    assertChunksFit,
    deterministicProvider,
    embedDocumentsChecked,
    EmbeddingCheckError,
    type EmbeddingProvider,
} from '../src/embedding.js';
import { EmbeddingProviderError, postJson } from '../src/providers/http.js';
import { norm, dot } from '../src/vector.js';

/** A window small enough that ordinary fixtures cross it. */
const narrow = (maxInputCodePoints: number): EmbeddingProvider => ({
    id: 'narrow',
    dimensions: 4,
    maxInputCodePoints,
    async embedDocuments(texts) {
        return texts.map(() => [1, 0, 0, 0]);
    },
    async embedQuery() {
        return [1, 0, 0, 0];
    },
});

describe('embedding — the window guard, first layer', () => {
    it('accepts a ceiling that fits', () => {
        expect(() => assertChunkCeilingFits(1200, narrow(1600))).not.toThrow();
        expect(() => assertChunkCeilingFits(1600, narrow(1600))).not.toThrow();
    });

    it('refuses a ceiling past the window, naming both numbers and the provider', () => {
        expect(() => assertChunkCeilingFits(2000, narrow(1600))).toThrow(/2000/);
        expect(() => assertChunkCeilingFits(2000, narrow(1600))).toThrow(/1600/);
        expect(() => assertChunkCeilingFits(2000, narrow(1600))).toThrow(/narrow/);
    });
});

describe('embedding — the window guard, second layer', () => {
    it('a configuration that passes the first layer can still produce a chunk that does not fit', () => {
        // This is the reason the guard has two layers. The ceiling is a budget,
        // not a bound: a sentence longer than it is emitted whole rather than
        // cut in half, so the parameter can fit the window while a chunk does
        // not. Checking only the parameter would approve this and let the
        // provider truncate the tail with no symptom.
        const provider = narrow(50);
        expect(() => assertChunkCeilingFits(50, provider)).not.toThrow();
        expect(() => assertChunksFit([{ id: 'd#7', text: 'x'.repeat(61) }], provider)).toThrow(/d#7/);
    });

    it('names the chunk and both sizes, because "a chunk did not fit" is not debuggable', () => {
        const boom = () => assertChunksFit([{ id: 'machado#217', text: 'á'.repeat(80) }], narrow(50));
        expect(boom).toThrow(/machado#217/);
        expect(boom).toThrow(/80 code points/);
        expect(boom).toThrow(/50/);
    });

    it('measures in code points, not in UTF-16 units', () => {
        // An emoji is one code point and two UTF-16 units. Measuring by
        // `.length` would reject a chunk that fits, and the whole library
        // counts positions in code points.
        const fits = [{ id: 'd#0', text: '🙂'.repeat(10) }];
        expect(() => assertChunksFit(fits, narrow(10))).not.toThrow();
        expect(fits[0]!.text.length).toBe(20);
    });

    it('says nothing when every chunk fits', () => {
        const chunks = [
            { id: 'a#0', text: 'curto' },
            { id: 'a#1', text: 'também curto' },
        ];
        expect(() => assertChunksFit(chunks, narrow(100))).not.toThrow();
    });
});

describe('embedding — the deterministic provider', () => {
    const provider = deterministicProvider(16);

    it('embeds without leaving the machine, and the vectors are unit length', async () => {
        const [v] = await provider.embedDocuments(['a escola pode proibir o celular']);
        expect(v).toHaveLength(16);
        expect(norm([...v!])).toBeCloseTo(1, 12);
    });

    it('the same text embeds the same way, which is what makes a test reproducible', async () => {
        const [a] = await provider.embedDocuments(['mesmo texto']);
        const [b] = await provider.embedDocuments(['mesmo texto']);
        expect(a).toEqual(b);
    });

    it('different texts land in different directions', async () => {
        const [a, b] = await provider.embedDocuments(['o aluno chegou', 'a prova foi adiada']);
        expect(dot([...a!], [...b!])).toBeLessThan(0.99);
    });

    it('an empty text is a vector, not a crash', async () => {
        // Every component would be the same hash of nothing; without the
        // offset the vector could come out unnormalizable, and the failure
        // would surface far from here.
        const [v] = await provider.embedDocuments(['']);
        expect(norm([...v!])).toBeCloseTo(1, 12);
    });

    it('embeds a batch in the order it was given', async () => {
        const vectors = await provider.embedDocuments(['um', 'dois', 'três']);
        expect(vectors).toHaveLength(3);
        const [again] = await provider.embedDocuments(['dois']);
        expect(vectors[1]).toEqual(again);
    });

    it('carries its dimension count in its id, so an artifact says what built it', () => {
        expect(deterministicProvider(8).id).toBe('deterministic-8');
        expect(deterministicProvider(8).dimensions).toBe(8);
    });

    it('refuses a dimension count that is not a positive integer', () => {
        expect(() => deterministicProvider(0)).toThrow(/positive integer/);
        expect(() => deterministicProvider(2.5)).toThrow(/positive integer/);
    });

    it('does not pretend to know meaning, and no test here may assume it does', async () => {
        // The pair a real provider would place close together. This one has no
        // reason to, and asserting otherwise would make the suite green on a
        // property it cannot have.
        const [health, disease] = await provider.embedDocuments(['condições de saúde', 'doença']);
        const [unrelated] = await provider.embedDocuments(['banda larga de alta velocidade']);
        const relatedScore = dot([...health!], [...disease!]);
        const unrelatedScore = dot([...health!], [...unrelated!]);
        expect(Number.isFinite(relatedScore)).toBe(true);
        expect(Number.isFinite(unrelatedScore)).toBe(true);
    });
});

describe('embedDocumentsChecked — the guard two layers share', () => {
    const base = deterministicProvider(4);

    it('hands back unit vectors even when the provider does not', async () => {
        // The attributor compares fresh vectors with `dot` and calls the result
        // a cosine. That is only true for unit vectors, and MAGNITUDE IS NOT
        // PART of the provider contract — so the guarantee has to live here.
        // A provider whose vectors are unit by construction cannot prove this:
        // normalizing twice changes nothing, and the test would be green with
        // and without the normalization.
        const long: EmbeddingProvider = {
            ...base,
            async embedDocuments(texts) {
                return texts.map(() => [30, 40, 0, 0]);
            },
        };
        const out = await embedDocumentsChecked(['a', 'b'], long);
        for (const v of out) expect(norm([...v])).toBeCloseTo(1, 12);
    });

    it('refuses fewer vectors than inputs, which would shift every later text', async () => {
        const short: EmbeddingProvider = {
            ...base,
            async embedDocuments(texts) {
                return texts.slice(1).map(() => [1, 0, 0, 0]);
            },
        };
        await expect(embedDocumentsChecked(['a', 'b'], short)).rejects.toThrow(
            /exactly one per input/,
        );
    });

    it('refuses a vector of the wrong width, naming which input', async () => {
        const wrong: EmbeddingProvider = {
            ...base,
            async embedDocuments(texts) {
                return texts.map((_, i) => (i === 1 ? [1, 0] : [1, 0, 0, 0]));
            },
        };
        await expect(embedDocumentsChecked(['a', 'b'], wrong)).rejects.toThrow(
            /2-dimension vector for input 1/,
        );
    });
});

describe('a failed check says WHY in a field, not in a sentence', () => {
    // TARGET OF THE REVERSAL: drop `reason` and leave the caller matching a
    // substring against `message`. That is the coupling this package refuses
    // for a provider's prose, and it would be odd to accept it for its own.
    const tooBig = (size: number) => ({
        id: 'c',
        documentId: 'd',
        text: 'x'.repeat(size),
        span: { start: 0, end: size },
    });

    it('a chunk past the window says input-too-large', () => {
        try {
            assertChunksFit([tooBig(50)], narrow(10));
            expect.unreachable('should have thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(EmbeddingCheckError);
            expect((error as EmbeddingCheckError).reason).toBe('input-too-large');
        }
    });

    it('the ceiling guard says input-too-large before any chunk exists', () => {
        try {
            assertChunkCeilingFits(50, narrow(10));
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as EmbeddingCheckError).reason).toBe('input-too-large');
        }
    });

    it('a short answer says bad-count and a wrong width says bad-dimensions', async () => {
        const short: EmbeddingProvider = {
            id: 'short',
            dimensions: 4,
            maxInputCodePoints: 1000,
            async embedDocuments() {
                return [[1, 0, 0, 0]];
            },
            async embedQuery() {
                return [1, 0, 0, 0];
            },
        };
        await expect(embedDocumentsChecked(['a', 'b'], short)).rejects.toMatchObject({
            reason: 'bad-count',
        });

        const wide: EmbeddingProvider = {
            ...short,
            async embedDocuments(texts) {
                return texts.map(() => [1, 0, 0, 0, 0]);
            },
        };
        await expect(embedDocumentsChecked(['a'], wide)).rejects.toMatchObject({
            reason: 'bad-dimensions',
        });
    });
});

describe('a provider failure without a status keeps its cause', () => {
    // TARGET OF THE REVERSAL: fold the cause into the message, as the code did
    // before this commit. Then a timeout and a DNS failure arrive identical,
    // and the only discriminator left is a substring.
    it('a timeout arrives distinguishable from a refused connection', async () => {
        const throwing = (error: unknown) => async () => {
            throw error;
        };

        const timeout = Object.assign(new Error('The operation was aborted'), {
            name: 'TimeoutError',
        });
        await expect(
            postJson({
                url: 'https://example.invalid/x',
                headers: {},
                body: {},
                providerId: 'p',
                fetch: throwing(timeout) as unknown as typeof globalThis.fetch,
            }),
        ).rejects.toSatisfy((error: unknown) => {
            const failure = error as EmbeddingProviderError;
            expect(failure.status).toBeUndefined();
            expect((failure.cause as Error).name).toBe('TimeoutError');
            return true;
        });

        const refused = Object.assign(new TypeError('fetch failed'), {
            cause: { code: 'ECONNREFUSED' },
        });
        await expect(
            postJson({
                url: 'https://example.invalid/x',
                headers: {},
                body: {},
                providerId: 'p',
                fetch: throwing(refused) as unknown as typeof globalThis.fetch,
            }),
        ).rejects.toSatisfy((error: unknown) => {
            const failure = error as EmbeddingProviderError;
            expect((failure.cause as Error).name).toBe('TypeError');
            return true;
        });
    });
});
