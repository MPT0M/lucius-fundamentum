import { describe, it, expect } from 'vitest';
import { applyDensity, type Placed, type ResolvedBy } from '../src/attribute.js';

/**
 * Four consecutive clauses of one passage, anchors twenty code points apart —
 * the arrangement the plan measured before the change, where the lexical row
 * read two markers and the dense row read four.
 */
const span = (clause: number, anchor: number, rung: ResolvedBy): Placed => ({
    span: {
        textSpan: { start: anchor - 15, end: anchor },
        anchorOffset: anchor,
        sourceSpan: { start: 0, end: 50 },
        chunkId: 'lei#2',
        documentId: 'lei',
        confidence: 0.5,
        resolvedBy: rung,
    },
    firstClause: clause,
    lastClause: clause,
    terms: new Set([`t${clause}`]),
    moved: false,
    fused: false,
    precise: true,
});

const ENDS = [20, 40, 60, 80, 200];
const OPTS = { coalesceMaxCodePoints: 80, minClusterCodePoints: 0 };

const run = (rungs: readonly ResolvedBy[]) =>
    applyDensity(
        rungs.map((rung, i) => span(i, 20 + i * 20, rung)),
        ENDS,
        () => 0.5,
        OPTS,
    );

describe('paraphrase groups, and the rung stops being a condition', () => {
    it('four dense clauses of one passage collapse the way four lexical ones do', () => {
        // TARGET OF THE REVERSAL: put back
        // `a.span.resolvedBy === 'lexical' && b.span.resolvedBy === 'lexical'`.
        // The dense row goes back to four markers where the lexical row shows
        // two, which is the debt this commit pays: the population that most
        // needed the merge was the only one that never got it.
        const lexical = run(['lexical', 'lexical', 'lexical', 'lexical']);
        const dense = run(['dense', 'dense', 'dense', 'dense']);
        expect(dense).toHaveLength(lexical.length);
        expect(dense.length).toBeLessThan(4);
    });

    it('a lexical clause and a dense one now fuse at all', () => {
        const out = run(['lexical', 'dense']);
        expect(out).toHaveLength(1);
    });
});

describe('the fused span declares the rung honestly, in all three cases', () => {
    it('two lexical stay lexical, two dense stay dense, one of each is mixed', () => {
        // TARGET OF THE REVERSAL: write `'lexical'` as a literal, which is
        // what the code did while the gate accepted nothing else. Two dense
        // spans fused would then claim a provenance they do not have.
        expect(run(['lexical', 'lexical'])[0]!.resolvedBy).toBe('lexical');
        expect(run(['dense', 'dense'])[0]!.resolvedBy).toBe('dense');
        expect(run(['lexical', 'dense'])[0]!.resolvedBy).toBe('mixed');
        expect(run(['dense', 'lexical'])[0]!.resolvedBy).toBe('mixed');
    });

    it('a mixed span is neither population, which is why it has its own name', () => {
        // `confidence` on a fused span is recomputed over the union by a
        // LEXICAL measure. Filing it under `'dense'` would put a lexical
        // number into the group the CHANGELOG says scores systematically
        // lower, and comparing the two groups would then compare instruments.
        const out = run(['lexical', 'dense']);
        expect(out[0]!.resolvedBy).not.toBe('dense');
        expect(out[0]!.resolvedBy).not.toBe('lexical');
    });
});
