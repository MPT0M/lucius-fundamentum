import { describe, it, expect } from 'vitest';
import {
    scoreResponse,
    DEFAULT_CITATION_OVERLAP_THRESHOLD,
    type CitationCandidate,
    type CitationSource,
    type LabeledFixture,
    type ScoreReport,
} from './score.js';
import type { MaskedCorpus } from './corpus.js';
import type { Occurrence } from './locate.js';
import type { ResolvedOrigin } from './origin.js';
import type { Span } from '../../src/types.js';
import { maskProtectedRegions } from '../../src/mask.js';

// ---------------------------------------------------------------------------
// Synthetic world. Every number below is small enough to check by hand.
//
//   document A = 'aaaa bbbb $x$ cccc dddd'   23 code points; formula region [10,13)
//   document B = 'zzzz yyyy'                   9 code points; no regions
//
//   response Part 0 = 'Frase um. Frase dois. Frase tres. Frase quatro.'
//     'Frase um.'     [0,9)    segment S0, gold A[0,9)   ('aaaa bbbb')
//     'Frase dois.'   [10,21)  segment S1, gold A[14,23) ('cccc dddd')
//     'Frase tres.'   [22,33)  unsupported
//     'Frase quatro.' [34,47)  segment S2, gold B[0,4)   ('zzzz')
// ---------------------------------------------------------------------------

const A = 'aaaa bbbb $x$ cccc dddd';
const B = 'zzzz yyyy';
const PART = 'Frase um. Frase dois. Frase tres. Frase quatro.';

const S0: Span = { start: 0, end: 9 };
const S1: Span = { start: 10, end: 21 };
const UNSUPPORTED: Span = { start: 22, end: 33 };
const S2: Span = { start: 34, end: 47 };

function corpus(): MaskedCorpus {
    return new Map([
        ['A', { text: A, regions: maskProtectedRegions(A).spans }],
        ['B', { text: B, regions: maskProtectedRegions(B).spans }],
    ]);
}

function labeled(segments: LabeledFixture['segments'] = [
    { partIndex: 0, textSpan: S0, sourceSpans: [{ documentId: 'A', span: { start: 0, end: 9 } }] },
    { partIndex: 0, textSpan: S1, sourceSpans: [{ documentId: 'A', span: { start: 14, end: 23 } }] },
    { partIndex: 0, textSpan: S2, sourceSpans: [{ documentId: 'B', span: { start: 0, end: 4 } }] },
]): LabeledFixture {
    return { id: 'fx', parts: [{ text: PART }], segments, labeledBy: 'MPT0M', labeledAt: '2026-09-08' };
}

const IN: ResolvedOrigin = { documentId: 'A', resolvedBy: 'customMetadata', inFixture: true };
const OUT: ResolvedOrigin = { documentId: 'B', resolvedBy: 'customMetadata', inFixture: false };
const NONE: ResolvedOrigin = { documentId: null, resolvedBy: null, inFixture: false };

const exact = (documentId: string, start: number, end: number, origin: ResolvedOrigin = IN): CitationSource => ({
    located: { kind: 'exact', documentId, span: { start, end } },
    origin,
});
const notFound = (snippet: string, origin: ResolvedOrigin = NONE): CitationSource => ({ located: { kind: 'not_found', snippet }, origin });
const ambiguous = (occurrences: readonly Occurrence[]): CitationSource => ({
    located: { kind: 'ambiguous', occurrences },
    origin: IN,
});

function cite(textSpan: Span, sources: readonly CitationSource[], rawChunkCount = sources.length, partIndex = 0): CitationCandidate {
    return { partIndex, textSpan, rawChunkCount, sources };
}

/**
 * Every scenario goes through here, so the two structural invariants of the
 * report are asserted in every test, not in a dedicated one that a future case
 * could bypass: the coverage denominator is net, and there is exactly one
 * overlap entry per scored marker.
 */
function score(citations: readonly CitationCandidate[], fixture = labeled()): ScoreReport {
    const r = scoreResponse(fixture, citations, corpus());
    expect(r.segmentsSustained + r.segmentsIndeterminate).toBe(fixture.segments.length);
    expect(r.overlapDistribution).toHaveLength(r.citationsScored);
    return r;
}

// ---------------------------------------------------------------------------

describe('scoreResponse — the overlap function and the threshold', () => {
    it('a citation that is exactly the gold span is correct with overlap 1 and granularity 1', () => {
        const r = score([cite(S0, [exact('A', 0, 9)])]);
        expect(r.citationsScored).toBe(1);
        expect(r.citationsCorrect).toBe(1);
        expect(r.overlapDistribution).toEqual([1]);
        expect(r.granularityDistribution).toEqual([1]);
    });

    it('a coarse citation that contains the gold is correct — coarseness goes to granularity, not to precision', () => {
        // Whole document A [0,23) against gold [0,9): intersection 9 → 9/9 = 1
        // by |∩|/|gold|. IoU would give 9/23 and call it wrong.
        const r = score([cite(S0, [exact('A', 0, 23)])]);
        expect(r.citationsCorrect).toBe(1);
        expect(r.overlapDistribution).toEqual([1]);
        expect(r.granularityDistribution[0]).toBeCloseTo(23 / 9, 10);
    });

    it('a narrow citation inside the gold is correct — |∩|/|cited| rescues what |∩|/|gold| alone would fail', () => {
        // [14,18) inside gold [14,23): 4/9 ≈ 0.44 by gold, 4/4 = 1 by cited → 1.
        const r = score([cite(S1, [exact('A', 14, 18)])]);
        expect(r.citationsCorrect).toBe(1);
        expect(r.overlapDistribution).toEqual([1]);
        expect(r.granularityDistribution[0]).toBeCloseTo(4 / 9, 10);
    });

    it('a citation that only brushes the gold is scored but wrong, and its granularity still counts because overlap > 0', () => {
        // [5,14) against gold [0,9): intersection [5,9) = 4; 4/9 ≈ 0.44 both ways → below 0.5.
        const r = score([cite(S0, [exact('A', 5, 14)])]);
        expect(r.citationsScored).toBe(1);
        expect(r.citationsCorrect).toBe(0);
        expect(r.overlapDistribution[0]).toBeCloseTo(4 / 9, 10);
        expect(r.granularityDistribution[0]).toBeCloseTo(9 / 9, 10);
    });

    it('an overlap exactly at the threshold is correct — the comparison is >=, not >', () => {
        // Gold [0,8) and citation [4,12): intersection 4 → 4/8 = 0.5 both ways.
        const fixture = labeled([{ partIndex: 0, textSpan: S0, sourceSpans: [{ documentId: 'A', span: { start: 0, end: 8 } }] }]);
        const r = scoreResponse(fixture, [cite(S0, [exact('A', 4, 12)])], corpus());
        expect(r.overlapDistribution[0]).toBeCloseTo(0.5, 10);
        expect(r.citationsCorrect).toBe(1);
    });

    it('the threshold is a parameter; the same citation flips with it', () => {
        const citations = [cite(S0, [exact('A', 5, 14)])];
        expect(scoreResponse(labeled(), citations, corpus(), 0.4).citationsCorrect).toBe(1);
        expect(scoreResponse(labeled(), citations, corpus(), DEFAULT_CITATION_OVERLAP_THRESHOLD).citationsCorrect).toBe(0);
    });

    it('a citation whose source is in another document scores zero overlap before any arithmetic', () => {
        // B[0,9) has the same numbers as gold A[0,9); the document decides.
        const r = score([cite(S0, [exact('B', 0, 9, OUT)])]);
        expect(r.citationsScored).toBe(1);
        expect(r.citationsCorrect).toBe(0);
        expect(r.overlapDistribution).toEqual([0]);
        expect(r.granularityDistribution).toEqual([]);
        expect(r.outsideFixture).toBe(1);
    });
});

describe('scoreResponse — matching a marker to a segment', () => {
    it('a marker on an unsupported sentence is scored and wrong, whatever it points at', () => {
        const r = score([cite(UNSUPPORTED, [exact('A', 0, 9)])]);
        expect(r.citationsScored).toBe(1);
        expect(r.citationsCorrect).toBe(0);
        expect(r.overlapDistribution).toEqual([0]);
    });

    it('a marker straddling two segments belongs to the one it overlaps more, and counts once', () => {
        // [6,14) overlaps S0 [0,9) by 3 and S1 [10,21) by 4 → S1. Its source is S1's gold.
        const r = score([cite({ start: 6, end: 14 }, [exact('A', 14, 23)])]);
        expect(r.citationsScored).toBe(1);
        expect(r.citationsCorrect).toBe(1);
        expect(r.segmentsCovered).toBe(1);
    });

    it('a marker overlapping two segments equally belongs to the earlier one', () => {
        // [5,14) overlaps S0 [0,9) by 4 and S1 [10,21) by 4. Tie → S0. Its
        // source is S0's gold, so it is correct only if S0 won the tie.
        const r = score([cite({ start: 5, end: 14 }, [exact('A', 0, 9)])]);
        expect(r.citationsCorrect).toBe(1);
        expect(r.segmentsCovered).toBe(1);
    });

    it('segments are matched within the same Part only — identical numbers in another Part never collide', () => {
        const twoParts: LabeledFixture = {
            ...labeled([
                { partIndex: 0, textSpan: S0, sourceSpans: [{ documentId: 'A', span: { start: 0, end: 9 } }] },
                { partIndex: 1, textSpan: S0, sourceSpans: [{ documentId: 'A', span: { start: 14, end: 23 } }] },
            ]),
            parts: [{ text: PART }, { text: PART }],
        };
        // Part 1's marker at [0,9) cites Part 0's gold — wrong for its own segment.
        const r = scoreResponse(twoParts, [cite(S0, [exact('A', 0, 9)], 1, 1)], corpus());
        expect(r.citationsCorrect).toBe(0);
        // And the right gold for Part 1 is correct there.
        const ok = scoreResponse(twoParts, [cite(S0, [exact('A', 14, 23)], 1, 1)], corpus());
        expect(ok.citationsCorrect).toBe(1);
    });

    it('two correct markers on one segment are two correct citations, one covered segment', () => {
        const r = score([cite(S0, [exact('A', 0, 9)]), cite({ start: 2, end: 7 }, [exact('A', 0, 9)])]);
        expect(r.citationsCorrect).toBe(2);
        expect(r.segmentsCovered).toBe(1);
    });
});

describe('scoreResponse — one marker is one citation, however many chunks it points at', () => {
    it('among located sources the greatest overlap is scored, and the choice is counted', () => {
        // First source brushes the gold (0.44), second is the gold itself (1). Chosen = second.
        const r = score([cite(S0, [exact('A', 5, 14), exact('A', 0, 9)], 2)]);
        expect(r.citationsScored).toBe(1);
        expect(r.citationsCorrect).toBe(1);
        expect(r.multiSourceSupports).toBe(1);
        expect(r.choiceSupports).toBe(1);
        expect(r.pickDifferedFromFirst).toBe(1);
        expect(r.partialSupports).toBe(0);
    });

    it('when the first located source is already the best, no pick differed', () => {
        const r = score([cite(S0, [exact('A', 0, 9), exact('A', 5, 14)], 2)]);
        expect(r.choiceSupports).toBe(1);
        expect(r.pickDifferedFromFirst).toBe(0);
    });

    it('a chunk discarded for lacking text makes the marker partial, not a choice', () => {
        // rawChunkCount 2, one source: multi yes, choice no, partial yes.
        const r = score([cite(S0, [exact('A', 0, 9)], 2)]);
        expect(r.multiSourceSupports).toBe(1);
        expect(r.choiceSupports).toBe(0);
        expect(r.partialSupports).toBe(1);
        expect(r.citationsCorrect).toBe(1);
    });

    it('[not_found, exact] is partial, scored by the one located source, and never a choice', () => {
        const r = score([cite(S0, [notFound('aaaa  bbbb'), exact('A', 0, 9)], 2)]);
        expect(r.citationsScored).toBe(1);
        expect(r.citationsCorrect).toBe(1);
        expect(r.multiSourceSupports).toBe(1);
        expect(r.choiceSupports).toBe(0);
        expect(r.pickDifferedFromFirst).toBe(0);
        expect(r.partialSupports).toBe(1);
        expect(r.notLocated).toEqual([NONE]);
    });

    it('a marker whose every source fell in a bucket is not scored, and its buckets are recorded', () => {
        const r = score([cite(S0, [notFound('x'), ambiguous([{ documentId: 'A', span: { start: 0, end: 4 } }, { documentId: 'A', span: { start: 5, end: 9 } }])], 2)]);
        expect(r.citationsScored).toBe(0);
        expect(r.notLocated).toHaveLength(1);
        expect(r.ambiguous).toEqual([{ sameDocument: true, documentIds: ['A'] }]);
        expect(r.partialSupports).toBe(0);
    });
});

describe('scoreResponse — a marker with no source at all', () => {
    it('is sourceless, outside every count, in both variants — and never partial', () => {
        const r = score([cite(S0, [], 0), cite(S0, [], 2)]);
        expect(r.sourceless).toBe(2);
        expect(r.citationsScored).toBe(0);
        expect(r.partialSupports).toBe(0);
        // rawChunkCount 2 with no text at all still counts as what the emitter attached.
        expect(r.multiSourceSupports).toBe(1);
        expect(r.scoredClassMass.plain).toBe(0);
    });
});

describe('scoreResponse — coverage has three states and a net denominator', () => {
    it('a segment whose only markers fell in buckets is indeterminate and leaves the denominator', () => {
        const r = score([
            cite(S0, [exact('A', 0, 9)]),
            cite(S2, [ambiguous([{ documentId: 'A', span: { start: 0, end: 4 } }, { documentId: 'A', span: { start: 5, end: 9 } }])]),
        ]);
        expect(r.segmentsCovered).toBe(1);
        expect(r.segmentsIndeterminate).toBe(1);
        expect(r.segmentsSustained).toBe(2); // S1 untouched stays in the denominator, uncovered
    });

    it('a segment whose only marker is sourceless is indeterminate, not uncovered', () => {
        const r = score([cite(S2, [], 0)]);
        expect(r.segmentsIndeterminate).toBe(1);
        expect(r.segmentsSustained).toBe(2);
    });

    it('a segment with a wrong scored marker is uncovered, and stays in the denominator', () => {
        const r = score([cite(S0, [exact('A', 5, 14)])]);
        expect(r.segmentsCovered).toBe(0);
        expect(r.segmentsIndeterminate).toBe(0);
        expect(r.segmentsSustained).toBe(3);
    });

    it('the invariants also hold on a mixed scenario that touches every state at once', () => {
        // The `score()` helper asserts both invariants in every test above;
        // this case makes sure they hold when covered, indeterminate and
        // uncovered segments coexist in one response.
        const r = score([
            cite(S0, [notFound('x')]),
            cite(S1, [exact('A', 14, 23)]),
            cite(S2, [exact('B', 0, 4, { ...IN, documentId: 'B' })]),
            cite(UNSUPPORTED, [exact('A', 0, 9)]),
        ]);
        expect(r.segmentsIndeterminate).toBe(1); // S0: only a bucket
        expect(r.segmentsCovered).toBe(2); // S1 and S2
        expect(r.segmentsSustained).toBe(2);
    });
});

describe('scoreResponse — passages are classified by coverage, not presence', () => {
    it('a whole-document citation with a small formula inside weighs the formula by its share', () => {
        // A is 23 code points with a 3-code-point formula: formula 3/23, plain 20/23.
        const r = score([cite(S0, [exact('A', 0, 23)])]);
        expect(r.scoredClassMass.formula).toBeCloseTo(3 / 23, 10);
        expect(r.scoredClassMass.plain).toBeCloseTo(20 / 23, 10);
        expect(r.scoredClassMass.code + r.scoredClassMass.url + r.scoredClassMass.abbreviation).toBe(0);
    });

    it('gold spans are classified against the document and counted per class', () => {
        const r = score([]);
        expect(r.goldSpanCount).toBe(3);
        expect(r.goldClassMass.plain).toBeCloseTo(3, 10);
        expect(r.goldSpansByClass.plain).toBe(3);
        expect(r.goldSpansByClass.formula).toBe(0);
    });

    it('an unlocated snippet is classified on its own text — the only masking the scorer does', () => {
        const r = score([cite(S0, [notFound('vale $x$ ok')])]); // 11 code points, formula [5,8) = 3
        expect(r.notLocatedClassMass.formula).toBeCloseTo(3 / 11, 10);
        expect(r.notLocatedClassMass.plain).toBeCloseTo(8 / 11, 10);
    });

    it('an empty snippet leaves the not-located mass at zero instead of poisoning the column with NaN', () => {
        // The locator returns not_found with snippet '' for an empty snippet;
        // a length-zero interval must contribute nothing, not 0/0.
        const r = score([cite(S0, [notFound('')])]);
        for (const v of Object.values(r.notLocatedClassMass)) expect(v).toBe(0);
        expect(r.notLocated).toHaveLength(1);
    });

    it('an ambiguous source is classified once, on its first occurrence', () => {
        const r = score([cite(S0, [ambiguous([{ documentId: 'A', span: { start: 10, end: 13 } }, { documentId: 'A', span: { start: 0, end: 4 } }])])]);
        expect(r.ambiguousClassMass.formula).toBeCloseTo(1, 10);
        expect(r.ambiguous).toHaveLength(1);
    });

    it('masses are sums, never rates: an empty response leaves every mass at zero and no NaN anywhere', () => {
        const r = score([]);
        // Three objects with the same keys: a spread would keep only the last.
        for (const mass of [r.scoredClassMass, r.notLocatedClassMass, r.ambiguousClassMass]) {
            for (const v of Object.values(mass)) expect(v).toBe(0);
        }
        expect(r.citationsScored).toBe(0);
        expect(r.citationsCorrect).toBe(0);
        expect(Number.isNaN(r.goldClassMass.plain)).toBe(false);
    });
});
