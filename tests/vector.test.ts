import { describe, it, expect } from 'vitest';
import { norm, normalize, dot, packVectors, unpackVectors } from '../src/vector.js';

describe('vector — normalization', () => {
    it('a normalized vector has unit length, and the direction survives', () => {
        const v = normalize([3, 4]);
        expect(norm(v)).toBeCloseTo(1, 12);
        expect(v).toEqual([0.6, 0.8]);
    });

    it('normalizing twice changes nothing that matters', () => {
        // Not byte-identical: the norm of an already-unit vector is 1 only to
        // within floating point, so dividing again moves the last bits. What
        // has to hold is that the second pass is a no-op at the precision the
        // scores are read at.
        const once = normalize([1, 2, 3, 4]);
        const twice = normalize(once);
        for (let i = 0; i < once.length; i += 1) expect(twice[i]!).toBeCloseTo(once[i]!, 15);
        expect(norm(twice)).toBeCloseTo(1, 15);
    });

    it('a vector with no direction is an error, not a vector of zeros', () => {
        // Returning zeros would score 0 against everything and read as "no
        // match" instead of "the provider handed back something unusable".
        expect(() => normalize([0, 0, 0])).toThrow(/no direction/);
        expect(() => normalize([1e-20, 0])).toThrow(/no direction/);
    });

    it('NaN and Infinity are named, not propagated', () => {
        expect(() => normalize([1, Number.NaN])).toThrow(/NaN or Infinity/);
        expect(() => normalize([Number.POSITIVE_INFINITY, 1])).toThrow(/NaN or Infinity/);
    });
});

describe('vector — dot product as cosine', () => {
    it('the dot of two unit vectors is their cosine', () => {
        expect(dot(normalize([1, 0]), normalize([1, 0]))).toBeCloseTo(1, 12);
        expect(dot(normalize([1, 0]), normalize([0, 1]))).toBeCloseTo(0, 12);
        expect(dot(normalize([1, 0]), normalize([-1, 0]))).toBeCloseTo(-1, 12);
        // 45 degrees.
        expect(dot(normalize([1, 0]), normalize([1, 1]))).toBeCloseTo(Math.SQRT1_2, 12);
    });

    it('comparing vectors of different sizes is an error, naming both', () => {
        expect(() => dot([1, 2], [1, 2, 3])).toThrow(/2 against 3/);
    });
});

describe('vector — the wire format', () => {
    const vectors = [
        [1, 0, 0, 0],
        [0.5, -0.5, 0.5, -0.5],
        [0, 0, 0, 1],
    ];

    it('a round trip returns what went in, within float32 precision', () => {
        const back = unpackVectors(packVectors(vectors), 4);
        expect(back).toHaveLength(3);
        for (let i = 0; i < vectors.length; i += 1) {
            for (let j = 0; j < 4; j += 1) expect(back[i]![j]!).toBeCloseTo(vectors[i]![j]!, 6);
        }
    });

    it('the byte order is pinned, not the machine that packed it', () => {
        // Little-endian float32 of 1.0 is 00 00 80 3F, which is AACAPw== in
        // base64. Pinning the literal is the only way this test fails on a
        // big-endian machine instead of passing by symmetry with itself.
        expect(packVectors([[1]])).toBe('AACAPw==');
        expect(unpackVectors('AACAPw==', 1)).toEqual([[1]]);
    });

    it('an empty corpus packs to an empty string and back', () => {
        expect(packVectors([])).toBe('');
        expect(unpackVectors('', 8)).toEqual([]);
    });

    it('refuses vectors of unequal size rather than writing a file nobody can read', () => {
        expect(() => packVectors([[1, 2], [1, 2, 3]])).toThrow(/3 dimensions among vectors of 2/);
    });

    it('refuses to unpack when the byte count does not divide by the declared dimensions', () => {
        // The artifact says how many dimensions it has; if the payload does not
        // agree, every vector after the first would be read at the wrong
        // offset and the scores would be noise that looks like scores.
        const packed = packVectors([[1, 2, 3, 4]]);
        expect(() => unpackVectors(packed, 3)).toThrow(/do not divide into vectors/);
    });

    it('refuses a payload that is not base64', () => {
        expect(() => unpackVectors('not base64!', 2)).toThrow(/not a base64 character/);
    });

    it('tells an empty corpus apart from a broken payload', () => {
        // Both used to decode to zero bytes and return an empty list, so a
        // corrupt artifact presented itself as an index with no chunks. That is
        // the worst shape for this failure: nothing throws, nothing is missing
        // on inspection, and every search simply finds nothing.
        expect(unpackVectors('', 4)).toEqual([]);
        expect(() => unpackVectors('====', 4)).toThrow(/nothing but padding/);
        expect(() => unpackVectors('A', 4)).toThrow(/leaves one over/);
        expect(() => unpackVectors('AAAAA', 4)).toThrow(/leaves one over/);
    });

    it('the leftover symbol is caught even when the byte count still divides', () => {
        // The one length where the downstream guard cannot help. Seventeen
        // valid base64 symbols with three dimensions: the first sixteen decode
        // to exactly twelve bytes, twelve IS the stride, so
        // `bytes.length % stride` is zero and the check passes — while the
        // seventeenth symbol's six bits are dropped with nothing to show for
        // it. Without the length rule this returns one plausible vector and
        // swallows the corruption.
        expect(() => unpackVectors('A'.repeat(17), 3)).toThrow(/17 base64 symbols/);
        // Sixteen is a legitimate payload and must still pass, or the rule
        // would be rejecting good artifacts to catch a bad one.
        expect(unpackVectors('A'.repeat(16), 3)).toHaveLength(1);
    });

    it('refuses a dimension count that is not a positive integer', () => {
        expect(() => unpackVectors('AACAPw==', 0)).toThrow(/positive integer/);
        expect(() => unpackVectors('AACAPw==', 1.5)).toThrow(/positive integer/);
    });

    it('survives a trip through JSON, which is how the artifact travels', () => {
        const packed = packVectors(vectors);
        const roundTripped = JSON.parse(JSON.stringify({ vectors: packed })) as { vectors: string };
        expect(unpackVectors(roundTripped.vectors, 4)).toEqual(unpackVectors(packed, 4));
    });

    it('packs a realistic vector count without losing a single one, or a value', () => {
        // Counting the vectors is not enough: a payload can have the right
        // length and the wrong contents, and 32 KB is where an offset slip
        // would first show up.
        const many = Array.from({ length: 500 }, (_, i) =>
            Array.from({ length: 16 }, (_, j) => Math.sin(i + j)),
        );
        const back = unpackVectors(packVectors(many), 16);
        expect(back).toHaveLength(500);
        for (const i of [0, 1, 249, 498, 499]) {
            for (let j = 0; j < 16; j += 1) expect(back[i]![j]!).toBeCloseTo(many[i]![j]!, 6);
        }
    });
});
