/**
 * What the reciprocal-rank sum does to an item that only ONE arm can rank.
 *
 * `index-build.ts` names this as declared debt at the line that creates it: a
 * chunk absent from a list is treated as ranked below every chunk present in
 * it, "which is right while every chunk can compete in both arms". Nothing in
 * the library can produce an ineligible chunk yet. This file fixes the
 * arithmetic of that day before it arrives, so the constant that decides it is
 * derived rather than chosen.
 *
 * **The file has two halves and they are not the same kind of thing.**
 *
 * The first exercises `index.search()` and would turn red if the fusion in
 * `index-build.ts` changed — it is the guard. The second is arithmetic over
 * the formula, and would stay green no matter what the package did; it is
 * kept because it pins the boundary that derives `k`, and it is labelled so
 * nobody mistakes it for coverage. An earlier version of this file was ALL
 * second half while reading as if it were all first: it imported one constant
 * from `src/` and tested helpers defined inside itself.
 */
import { describe, it, expect } from 'vitest';
import { createDenseIndex, FUSION_K } from '../src/index-build.js';
import type { EmbeddingProvider } from '../src/embedding.js';
import type { SourceDoc } from '../src/chunker.js';

const SMALL = { maxChunkCodePoints: 16, maxOverlapCodePoints: 0 };

/**
 * Three chunks, and only one of them carries the query term. The lexical arm
 * can therefore rank exactly one; the dense arm ranks all three. That split is
 * what makes a one-arm item and a two-arm item exist in the same result.
 */
const CORPUS: readonly SourceDoc[] = [
    { id: 'd', text: 'A casa azul.\n\nO carro veloz.\n\nO muro alto.' },
];

/** Places each chunk in the dense ranking by hand, so the pair is known. */
const placed = (order: readonly string[]): EmbeddingProvider => ({
    id: 'placed',
    dimensions: 2,
    maxInputCodePoints: 1000,
    modalities: ['text'],
    async embedDocuments(texts) {
        return texts.map((text) => {
            const i = order.findIndex((needle) => text.includes(needle));
            const angle = (i === -1 ? order.length : i) * 0.3;
            return [Math.cos(angle), Math.sin(angle)];
        });
    },
    async embedQuery() {
        return [1, 0];
    },
});

describe('the fusion the package actually runs', () => {
    it('gives a one-arm item ONE contribution and a two-arm item the sum of two', async () => {
        // 'azul' is in the first chunk only, so the lexical arm ranks that one
        // and nothing else. The dense arm ranks all three, in the order given.
        const index = await createDenseIndex(CORPUS, placed(['veloz', 'azul', 'muro']), {
            chunkOptions: SMALL,
        });
        const results = await index.search('azul');
        const by = (needle: string) => results.find((r) => r.chunk.text.includes(needle))!;

        // The dense order is veloz, azul, muro -> ranks 1, 2, 3.
        // The lexical list holds azul alone -> rank 1.
        const veloz = by('veloz');
        const azul = by('azul');

        // One arm, one term. This is the assertion a divisor would break.
        expect(veloz.score).toBeCloseTo(1 / (FUSION_K + 1), 12);
        // Two arms, two terms, no penalty for either.
        expect(azul.score).toBeCloseTo(1 / (FUSION_K + 2) + 1 / (FUSION_K + 1), 12);

        // And the fixture is not vacuous: the two really did come through
        // different numbers of arms.
        expect(azul.score).toBeGreaterThan(veloz.score);
    });

    it('a one-arm item at the SAME rank scores exactly half of a two-arm one', async () => {
        // The ratio, measured on real output rather than on a local helper.
        // Placing 'azul' first in the dense order puts it at rank 1 in both
        // lists, which is the only arrangement where the halving is visible
        // without arithmetic on the side.
        const index = await createDenseIndex(CORPUS, placed(['azul', 'veloz', 'muro']), {
            chunkOptions: SMALL,
        });
        const results = await index.search('azul');
        const by = (needle: string) => results.find((r) => r.chunk.text.includes(needle))!;

        const azul = by('azul'); // dense rank 1 AND lexical rank 1
        const veloz = by('veloz'); // dense rank 2, absent from lexical

        expect(azul.score).toBeCloseTo(2 / (FUSION_K + 1), 12);
        // Same rank comparison needs the same rank, so this compares against
        // the formula rather than against `veloz`, which sits one lower.
        expect(1 / (FUSION_K + 1) / azul.score).toBeCloseTo(0.5, 12);
        expect(veloz.score).toBeLessThan(azul.score);
    });
});

/**
 * Arithmetic over the fusion formula. These would pass whatever the package
 * did — they are here to pin the boundary that derives `k`, not to guard the
 * implementation. The guard is the block above.
 */
describe('the formula, and the boundary that derives k', () => {
    const arm = (k: number, rank: number): number => 1 / (k + rank);
    const twoArms = (k: number, rank: number): number => 2 * arm(k, rank);
    const KS = [1, 2, 5, 10, 20, 30, 60, 100] as const;

    it('a leading one-arm item TIES a two-arm item at rank k+2', () => {
        // `index-build.ts` published this boundary and the reason the tie is
        // exact: doubling is exact in binary, so `1/122 + 1/122` and `1/61`
        // are the same double. Exact equality is what verifies that claim.
        for (const k of KS) {
            expect(twoArms(k, k + 2)).toBe(arm(k, 1));
        }
    });

    it('a leading one-arm item loses at rank k+1 and wins at rank k+3', () => {
        // Named by the predicate, because "above" and "below" invert
        // depending on whether the reader means position or quality.
        for (const k of KS) {
            expect(arm(k, 1)).toBeLessThan(twoArms(k, k + 1));
            expect(arm(k, 1)).toBeGreaterThan(twoArms(k, k + 3));
        }
    });

    it('turns k into a product decision: for every two-arm item at r >= N, k <= N-3', () => {
        for (const n of [10, 20, 65, 103]) {
            for (const k of [n - 3, n - 4, Math.max(1, n - 20)]) {
                expect(arm(k, 1)).toBeGreaterThan(twoArms(k, n));
            }
            expect(arm(n - 2, 1)).toBe(twoArms(n - 2, n));
        }
    });

    it('the boundary describes ONE profile, not every score the curve reaches', () => {
        // A chunk buried in the dense arm but leading the lexical one beats
        // the one-arm leader, and the equal-rank analysis says nothing about
        // it. The equal-rank curve DOES reach this score, near r = 39 — what
        // is outside the analysis is the rank PROFILE (200, 1), not the value.
        const k = 60;
        const lopsided = arm(k, 200) + arm(k, 1);
        expect(lopsided).toBeGreaterThan(arm(k, 1));
        expect(lopsided).toBeGreaterThan(twoArms(k, 62));
        // The value itself sits between two points of the curve.
        expect(lopsided).toBeLessThan(twoArms(k, 38));
        expect(lopsided).toBeGreaterThan(twoArms(k, 39));
    });
});
