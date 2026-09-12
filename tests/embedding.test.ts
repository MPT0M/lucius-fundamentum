import { describe, it, expect } from 'vitest';
import {
    assertChunkCeilingFits,
    assertChunksFit,
    deterministicProvider,
    type EmbeddingProvider,
} from '../src/embedding.js';
import { norm, dot } from '../src/vector.js';

/** A window small enough that ordinary fixtures cross it. */
const narrow = (maxInputCodePoints: number): EmbeddingProvider => ({
    id: 'narrow',
    dimensions: 4,
    maxInputCodePoints,
    async embed(texts) {
        return texts.map(() => [1, 0, 0, 0]);
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
        const [v] = await provider.embed(['a escola pode proibir o celular']);
        expect(v).toHaveLength(16);
        expect(norm([...v!])).toBeCloseTo(1, 12);
    });

    it('the same text embeds the same way, which is what makes a test reproducible', async () => {
        const [a] = await provider.embed(['mesmo texto']);
        const [b] = await provider.embed(['mesmo texto']);
        expect(a).toEqual(b);
    });

    it('different texts land in different directions', async () => {
        const [a, b] = await provider.embed(['o aluno chegou', 'a prova foi adiada']);
        expect(dot([...a!], [...b!])).toBeLessThan(0.99);
    });

    it('an empty text is a vector, not a crash', async () => {
        // Every component would be the same hash of nothing; without the
        // offset the vector could come out unnormalizable, and the failure
        // would surface far from here.
        const [v] = await provider.embed(['']);
        expect(norm([...v!])).toBeCloseTo(1, 12);
    });

    it('embeds a batch in the order it was given', async () => {
        const vectors = await provider.embed(['um', 'dois', 'três']);
        expect(vectors).toHaveLength(3);
        const [again] = await provider.embed(['dois']);
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
        const [health, disease] = await provider.embed(['condições de saúde', 'doença']);
        const [unrelated] = await provider.embed(['banda larga de alta velocidade']);
        const relatedScore = dot([...health!], [...disease!]);
        const unrelatedScore = dot([...health!], [...unrelated!]);
        expect(Number.isFinite(relatedScore)).toBe(true);
        expect(Number.isFinite(unrelatedScore)).toBe(true);
    });
});
