import { describe, it, expect } from 'vitest';
import {
    applyDensity,
    applyFloor,
    coalescePass,
    DEFAULT_COALESCE_MAX_CODE_POINTS,
    DEFAULT_MIN_CLUSTER_CODE_POINTS,
    type Placed,
} from '../src/attribute.js';

/** A placed span, described by the only things the density rules read. */
function placed(
    clause: number,
    anchor: number,
    chunkId: string,
    extra: Partial<Placed> = {},
): Placed {
    return {
        span: {
            textSpan: { start: anchor - 20, end: anchor },
            anchorOffset: anchor,
            sourceSpan: { start: 0, end: 10 },
            chunkId,
            documentId: 'doc',
            confidence: 0.9,
            resolvedBy: 'lexical',
            ...(extra.span ?? {}),
        },
        firstClause: clause,
        lastClause: clause,
        terms: new Set([`t${clause}`]),
        moved: false,
        fused: false,
        ...extra,
    };
}

/** Confidence is recomputed over the union; a stand-in that is observable. */
const recompute = (terms: ReadonlySet<string>) => terms.size / 10;

describe('coalescePass — adjacency is measured over CLAUSES', () => {
    it('fuses two consecutive clauses of the same passage', () => {
        const out = coalescePass([placed(0, 40, 'c1'), placed(1, 90, 'c1')], () => true, recompute, 80);
        expect(out).toHaveLength(1);
        expect(out[0]!.span.anchorOffset).toBe(90);
        expect(out[0]!.span.textSpan).toEqual({ start: 20, end: 90 });
    });

    it('does NOT fuse across a clause that produced no span', () => {
        // The streaming caller has no span for the middle clause; the batch one
        // has a dense span there. A rule reading span neighbours would fuse here
        // in one mode and not the other, and the marker on screen would change.
        // Worse: `Span` is contiguous, so the fused textSpan would CONTAIN the
        // clause in between — support claimed over text the passage lacks.
        const out = coalescePass(
            [placed(0, 40, 'c1'), placed(2, 90, 'c1')],
            () => true,
            recompute,
            80,
        );
        expect(out).toHaveLength(2);
    });

    it('does not fuse two different passages, however close', () => {
        const out = coalescePass([placed(0, 40, 'c1'), placed(1, 45, 'c2')], () => true, recompute, 80);
        expect(out).toHaveLength(2);
    });

    it('does not fuse beyond the window', () => {
        const out = coalescePass(
            [placed(0, 0, 'c1'), placed(1, 200, 'c1')],
            () => true,
            recompute,
            80,
        );
        expect(out).toHaveLength(2);
    });

    it('does not chain: a fused span is closed', () => {
        const out = coalescePass(
            [placed(0, 0, 'c1'), placed(1, 40, 'c1'), placed(2, 80, 'c1')],
            () => true,
            recompute,
            80,
        );
        // 0+1 fuse; 2 stands alone rather than joining the pair.
        expect(out).toHaveLength(2);
        expect(out[0]!.fused).toBe(true);
        expect(out[1]!.fused).toBe(false);
    });

    it('recomputes confidence over the union instead of choosing between two', () => {
        const out = coalescePass([placed(0, 40, 'c1'), placed(1, 90, 'c1')], () => true, recompute, 80);
        // Two distinct terms in the union; the stand-in makes that observable.
        expect(out[0]!.span.confidence).toBe(0.2);
    });
});

describe('applyFloor — the anchor moves, the span does not', () => {
    const ends = [40, 100, 190, 260];

    it('defers an anchor that lands too close to the previous one', () => {
        const out = applyFloor([placed(0, 40, 'c1'), placed(1, 60, 'c2')], ends, 70);
        expect(out[1]!.span.anchorOffset).toBe(190);
        expect(out[1]!.moved).toBe(true);
        // The span still points at the clause that is actually supported.
        expect(out[1]!.span.textSpan).toEqual({ start: 40, end: 60 });
    });

    it('zero turns the floor off and leaves an anchor on every clause', () => {
        const items = [placed(0, 40, 'c1'), placed(1, 60, 'c2'), placed(2, 70, 'c3')];
        const out = applyFloor(items, ends, 0);
        expect(out.map((p) => p.span.anchorOffset)).toEqual([40, 60, 70]);
        expect(out.every((p) => !p.moved)).toBe(true);
    });

    it('on the LAST clause the floor gives way and the citation stays', () => {
        // There is no next clause to defer to. Suppressing it would make the
        // last citation of every short answer disappear with no symptom, which
        // is a loss of correctness rather than of legibility.
        const out = applyFloor([placed(0, 40, 'c1'), placed(3, 60, 'c2')], ends, 70);
        expect(out).toHaveLength(2);
        expect(out[1]!.span.anchorOffset).toBe(60);
        expect(out[1]!.moved).toBe(false);
    });
});

describe('applyDensity — the order of the passes changes the page', () => {
    const ends = [40, 100, 190, 260, 320];
    const recomputeOne = () => 0.5;

    it('fusing before spacing gives ONE chip where spacing first gives two', () => {
        // Two clauses of one passage, 60 apart: inside the fusion window and
        // under the floor. Spacing first defers the second past the window and
        // the pair can never be fused again.
        const near = [placed(0, 0, 'c1'), placed(1, 60, 'c1')];
        const nearEnds = [0, 60, 190];

        const real = applyDensity(near, nearEnds, recomputeOne, {
            coalesceMaxCodePoints: 80,
            minClusterCodePoints: 70,
        });

        // PROOF BY REVERSAL: the other order, run here, disagrees.
        const floorFirst = coalescePass(
            applyFloor(near, nearEnds, 70),
            () => true,
            recomputeOne,
            80,
        );

        expect(real).toHaveLength(1);
        expect(floorFirst).toHaveLength(2);
    });

    it('the second pass catches what the floor pushed back together', () => {
        // Everything of one passage inside the window is already fused, so a
        // surviving pair is further apart than the window — and those are the
        // pairs the floor defers, landing them next to each other again.
        const items = [placed(0, 0, 'c1'), placed(1, 100, 'c1'), placed(2, 190, 'c1')];
        const out = applyDensity(items, ends, recomputeOne, {
            coalesceMaxCodePoints: 80,
            minClusterCodePoints: 200,
        });
        expect(out.length).toBeLessThan(items.length);
    });

    it('a span takes part in at most one fusion across both passes', () => {
        const items = [placed(0, 0, 'c1'), placed(1, 40, 'c1'), placed(2, 80, 'c1')];
        const out = applyDensity(items, ends, recomputeOne, {
            coalesceMaxCodePoints: 80,
            minClusterCodePoints: 200,
        });
        // 0+1 fuse in the first pass and are closed; 2 is never folded in.
        expect(out).toHaveLength(2);
    });

    it('the defaults are exported to be read, not tuned in place', () => {
        expect(DEFAULT_COALESCE_MAX_CODE_POINTS).toBe(80);
        expect(DEFAULT_MIN_CLUSTER_CODE_POINTS).toBe(70);
    });
});
