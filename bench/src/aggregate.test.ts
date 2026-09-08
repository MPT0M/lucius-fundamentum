import { describe, it, expect } from 'vitest';
import { aggregateRun, MAX_UNMATCHED_DOCUMENT_RATIO, MIN_SCORED_CITATIONS, recordedAtOf, type RunMeta } from './aggregate.js';
import type { GoogleRawFixture } from './fixture.js';
import type { ParseResult } from './parse.js';
import { PASSAGE_CLASSES, type ClassMass, type ScoreReport } from './score.js';

// ---------------------------------------------------------------------------
// Builders. Every field starts at zero or empty, so a test names only what it
// is about, and a sum that picks up a field the test did not set is caught.
// ---------------------------------------------------------------------------

function mass(partial: Partial<ClassMass> = {}): ClassMass {
    const m = Object.fromEntries(PASSAGE_CLASSES.map((k) => [k, 0])) as Record<string, number>;
    return { ...m, ...partial } as ClassMass;
}

function report(partial: Partial<ScoreReport> = {}): ScoreReport {
    return {
        citationsCorrect: 0,
        citationsScored: 0,
        segmentsCovered: 0,
        segmentsSustained: 0,
        segmentsIndeterminate: 0,
        overlapDistribution: [],
        granularityDistribution: [],
        goldSpanCount: 0,
        goldClassMass: mass(),
        scoredClassMass: mass(),
        ambiguousClassMass: mass(),
        notLocatedClassMass: mass(),
        multiSourceSupports: 0,
        choiceSupports: 0,
        pickDifferedFromFirst: 0,
        partialSupports: 0,
        sourceless: 0,
        outsideFixture: 0,
        notLocated: [],
        goldSpansByClass: mass(),
        ambiguous: [],
        ...partial,
    };
}

function parsed(partial: Partial<ParseResult['violations']> = {}, snaps: { starts?: number; ends?: number } = {}): ParseResult {
    return {
        candidates: [],
        snappedStarts: snaps.starts ?? 0,
        snappedEnds: snaps.ends ?? 0,
        violations: { length: [], position: [], missingPart: [], missingField: [], ...partial },
    };
}

const META: RunMeta = {
    model: 'test-model',
    recordedAt: '2026-09-08',
    reportVersion: 'test',
    storeEmbeddingModel: 'test-embedding',
    storeChunking: { maxTokensPerChunk: 100, maxOverlapTokens: 10 },
    providerId: null,
    formatVersion: null,
};

function fixture(partial: Partial<GoogleRawFixture> = {}): GoogleRawFixture {
    return {
        id: 'fx',
        model: META.model,
        recordedAt: META.recordedAt,
        reportVersion: META.reportVersion,
        storeEmbeddingModel: META.storeEmbeddingModel,
        storeChunking: META.storeChunking,
        parts: [{ text: 'x' }],
        usageMetadata: { toolUsePromptTokenCount: 1 },
        groundingMetadata: { groundingChunks: [{ retrievedContext: { text: 'x' } }], groundingSupports: [] },
        ...partial,
    };
}

/** The fixture with no `groundingMetadata` key at all — the shape protobuf emits when nothing came back. */
function withoutGrounding(f: GoogleRawFixture): GoogleRawFixture {
    const { groundingMetadata: _dropped, ...rest } = f;
    return rest;
}

/** N responses that share one report, one parse result and one fixture. */
function run(n: number, r: ScoreReport = report(), p: ParseResult = parsed(), f: GoogleRawFixture = fixture()) {
    // `Array(n).fill(x)` is `any[]` and would take the three parameters out of the typecheck.
    const times = <T>(x: T): T[] => Array.from({ length: n }, () => x);
    return aggregateRun(times(r), times(p), times(f), META);
}

const NO_NAN = (value: unknown): void => {
    if (typeof value === 'number') expect(Number.isNaN(value)).toBe(false);
    else if (Array.isArray(value)) value.forEach(NO_NAN);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(NO_NAN);
};

describe('aggregateRun — sums, never rates, until here', () => {
    it('precision, coverage and the distributions are sums and concatenations over the responses', () => {
        // Five counters, five distinct sums: a slot wired to the wrong field cannot pass.
        const r = report({
            citationsCorrect: 2,
            citationsScored: 3,
            segmentsCovered: 5,
            segmentsSustained: 7,
            segmentsIndeterminate: 9,
            overlapDistribution: [1, 0.5, 0],
            granularityDistribution: [2],
        });
        const out = run(4, r);
        expect(out.responses).toBe(4);
        expect(out.precision).toEqual({ correct: 8, scored: 12 });
        expect(out.coverage).toEqual({ covered: 20, sustained: 28 });
        expect(out.overlapDistribution).toHaveLength(12);
        expect(out.granularityDistribution).toEqual([2, 2, 2, 2]);
        expect(out.buckets.indeterminateSegments).toBe(36);
    });

    it('an empty round publishes 0/0 and no NaN anywhere, and is not a sufficient sample', () => {
        const out = aggregateRun([], [], [], META);
        NO_NAN(out);
        expect(out.precision).toEqual({ correct: 0, scored: 0 });
        expect(out.sampleSufficient).toBe(false);
        expect(out.publishable).toBe(true);
        expect(out.buckets.notLocated.byDocument).toEqual({});
    });

    it('the three arrays must be parallel: a length mismatch is refused, not silently zipped', () => {
        expect(() => aggregateRun([report()], [], [fixture()], META)).toThrow(RangeError);
        expect(() => aggregateRun([report()], [parsed()], [], META)).toThrow(/1 reports, 1 parse results, 0 fixtures/);
    });

    it('the header is copied from meta, not from any fixture — every field the fixture also carries', () => {
        const divergent = fixture({
            model: 'other-model',
            recordedAt: 'another-day',
            reportVersion: 'other-version',
            storeEmbeddingModel: 'other-embedding',
            storeChunking: { maxTokensPerChunk: 1, maxOverlapTokens: 0 },
        });
        const out = run(1, report(), parsed(), divergent);
        expect(out.model).toBe(META.model);
        expect(out.recordedAt).toBe(META.recordedAt);
        expect(out.reportVersion).toBe(META.reportVersion);
        expect(out.storeEmbeddingModel).toBe(META.storeEmbeddingModel);
        expect(out.storeChunking).toEqual(META.storeChunking);
        expect(out.providerId).toBeNull();
        // The divergence is not silent: it is the meta mismatch the gate reads.
        expect(out.metaMismatch).toBe(1);
    });
});

describe('aggregateRun — the class table is four mean fractions and one ratio', () => {
    it('each column divides the summed mass by its own population', () => {
        const r = report({
            citationsScored: 2,
            goldSpanCount: 4,
            goldClassMass: mass({ formula: 1.2, plain: 2.8 }),
            scoredClassMass: mass({ formula: 0.1, plain: 1.9 }),
            ambiguous: [{ sameDocument: true, documentIds: ['A'] }],
            ambiguousClassMass: mass({ code: 0.5, plain: 0.5 }),
            notLocated: [
                { documentId: 'A', resolvedBy: 'title', inFixture: true },
                { documentId: 'A', resolvedBy: 'title', inFixture: true },
                { documentId: 'A', resolvedBy: 'title', inFixture: true },
            ],
            notLocatedClassMass: mass({ url: 1, plain: 2 }),
            goldSpansByClass: mass({ formula: 3, plain: 4 }),
        });
        // Populations over two responses: gold 8, scored 4, ambiguous 2, notLocated 6 — all distinct,
        // so a column divided by another column's population cannot pass.
        const out = run(2, r);
        expect(out.byClass.formula.gold).toBeCloseTo(2.4 / 8);
        expect(out.byClass.formula.scored).toBeCloseTo(0.2 / 4);
        expect(out.byClass.code.ambiguous).toBeCloseTo(1 / 2);
        expect(out.byClass.url.notLocated).toBeCloseTo(2 / 6);
        expect(out.byClass.formula.goldSpans).toBe(6);
        expect(out.byClass.formula.scoredOverGold).toBeCloseTo(0.2 / 4 / (2.4 / 8));
    });

    it('the ratio is null where the gold has no mass in the class, not Infinity or NaN', () => {
        const r = report({ citationsScored: 1, goldSpanCount: 1, goldClassMass: mass({ plain: 1 }), scoredClassMass: mass({ code: 1 }) });
        const out = run(1, r);
        expect(out.byClass.code.scoredOverGold).toBeNull();
        expect(out.byClass.plain.scoredOverGold).toBe(0);
        NO_NAN(out);
    });

    it('a column over an empty population reports 0, and the count beside it says why', () => {
        const out = run(1, report({ citationsScored: 1, scoredClassMass: mass({ plain: 1 }) }));
        expect(out.byClass.plain.ambiguous).toBe(0);
        expect(out.buckets.ambiguous.count).toBe(0);
    });
});

describe('aggregateRun — the two gates are separate', () => {
    it('a position violation anywhere in the round makes it unpublishable', () => {
        const out = aggregateRun([report(), report()], [parsed(), parsed({ position: [0] })], [fixture(), fixture()], META);
        expect(out.parseViolations.position).toBe(1);
        expect(out.publishable).toBe(false);
    });

    it('a missing Part or a missing field makes it unpublishable', () => {
        expect(run(1, report(), parsed({ missingPart: [0] })).publishable).toBe(false);
        expect(run(1, report(), parsed({ missingField: [{ segment: 0, field: 'endIndex' }] })).publishable).toBe(false);
    });

    it('length failures that are all +1 decide the endIndex hypothesis; the round is still not published as it stands', () => {
        const out = run(2, report(), parsed({ length: [{ segment: 0, lengthDelta: 1 }, { segment: 1, lengthDelta: 1 }] }));
        expect(out.parseViolations.length).toBe(4);
        expect(out.parseViolations.lengthDeltaAllPlusOne).toBe(true);
        expect(out.publishable).toBe(false);
    });

    it('length failures with mixed signs are noise: the hypothesis is not decided and the round is not published', () => {
        const out = run(1, report(), parsed({ length: [{ segment: 0, lengthDelta: 1 }, { segment: 1, lengthDelta: -1 }] }));
        expect(out.parseViolations.lengthDeltaAllPlusOne).toBe(false);
        expect(out.publishable).toBe(false);
    });

    it('no length failure at all is not "all +1"', () => {
        expect(run(1).parseViolations.lengthDeltaAllPlusOne).toBe(false);
    });

    it('a fixture recorded under another model or store is a meta mismatch and makes the round unpublishable', () => {
        const other = fixture({ model: 'other-model' });
        const out = aggregateRun([report(), report()], [parsed(), parsed()], [fixture(), other], META);
        expect(out.metaMismatch).toBe(1);
        expect(out.publishable).toBe(false);
        expect(run(1, report(), parsed(), fixture({ storeChunking: { maxTokensPerChunk: 100, maxOverlapTokens: 11 } })).metaMismatch).toBe(1);
        expect(run(1, report(), parsed(), fixture({ storeChunking: { maxTokensPerChunk: 101, maxOverlapTokens: 10 } })).metaMismatch).toBe(1);
        expect(run(1, report(), parsed(), fixture({ storeEmbeddingModel: 'other' })).metaMismatch).toBe(1);
    });

    it('a fixture recorded on another date than the header is a meta mismatch: a round that reuses old answers cannot stamp them with today', () => {
        const out = run(1, report(), parsed(), fixture({ recordedAt: 'another-day' }));
        expect(out.metaMismatch).toBe(1);
        expect(out.publishable).toBe(false);
    });

    it('an interval header covers the answers inside it, including its ends, and refuses one on either side', () => {
        const interval = { ...META, recordedAt: '2026-09-08T11:17:27.530Z/2026-09-08T15:40:00.000Z' };
        // Both ends belong to the interval: they are the answers that defined it.
        const early = fixture({ recordedAt: '2026-09-08T11:17:27.530Z' });
        const middle = fixture({ recordedAt: '2026-09-08T12:00:00.000Z' });
        const late = fixture({ recordedAt: '2026-09-08T15:40:00.000Z' });
        const covered = aggregateRun([report(), report(), report()], [parsed(), parsed(), parsed()], [early, middle, late], interval);
        expect(covered.metaMismatch).toBe(0);
        expect(covered.publishable).toBe(true);

        const before = fixture({ recordedAt: '2026-09-07T23:00:00.000Z' });
        const after = fixture({ recordedAt: '2026-09-09T08:00:00.000Z' });
        const spilled = aggregateRun([report(), report()], [parsed(), parsed()], [before, after], interval);
        expect(spilled.metaMismatch).toBe(2);
        expect(spilled.publishable).toBe(false);
    });

    it('sampleSufficient is decided by scored citations alone, at the declared minimum, and does not touch publishable', () => {
        const below = run(1, report({ citationsScored: MIN_SCORED_CITATIONS - 1 }));
        const at = run(1, report({ citationsScored: MIN_SCORED_CITATIONS }));
        expect(below.sampleSufficient).toBe(false);
        expect(below.publishable).toBe(true);
        expect(at.sampleSufficient).toBe(true);
    });
});

describe('recordedAtOf — the header date is computed from the answers, never chosen', () => {
    it('answers recorded together publish that instant', () => {
        expect(recordedAtOf([fixture(), fixture()])).toBe(META.recordedAt);
    });

    it('answers recorded in more than one session publish the interval that covers them, earliest first', () => {
        const a = fixture({ recordedAt: '2026-09-08T15:40:00.000Z' });
        const b = fixture({ recordedAt: '2026-09-08T11:17:27.530Z' });
        const c = fixture({ recordedAt: '2026-09-08T12:00:00.000Z' });
        expect(recordedAtOf([a, b, c])).toBe('2026-09-08T11:17:27.530Z/2026-09-08T15:40:00.000Z');
    });

    it('a round with no answer has no date to publish', () => {
        expect(() => recordedAtOf([])).toThrow(RangeError);
    });
});

describe('aggregateRun — the fields born here, read from the raw fixture', () => {
    it('googleActivation counts responses whose recording says the search ran, in either spelling', () => {
        const camel = fixture({ usageMetadata: { toolUsePromptTokenCount: 5 } });
        const snake = fixture({ usageMetadata: { tool_use_prompt_token_count: 5 } });
        const neither = fixture({ usageMetadata: {} });
        const out = aggregateRun([report(), report(), report()], [parsed(), parsed(), parsed()], [camel, snake, neither], META);
        expect(out.googleActivation).toEqual({ toolUsed: 2, of: 3 });
    });

    it('emptyMetadata is a response where the search ran and nothing came back — absent or empty grounding alike', () => {
        const absent = withoutGrounding(fixture());
        const empty = fixture({ groundingMetadata: { groundingChunks: [], groundingSupports: [] } });
        const supportsOnly = fixture({ groundingMetadata: { groundingSupports: [{ segment: { endIndex: 1, text: 'x' } }] } });
        const out = aggregateRun([report(), report(), report()], [parsed(), parsed(), parsed()], [absent, empty, supportsOnly], META);
        expect(out.buckets.emptyMetadata).toBe(2);
    });

    it('a response that did not search is not emptyMetadata, however empty its grounding', () => {
        const out = run(1, report(), parsed(), withoutGrounding(fixture({ usageMetadata: {} })));
        expect(out.buckets.emptyMetadata).toBe(0);
        expect(out.googleActivation.toolUsed).toBe(0);
    });

    it('snapping counters are summed over the parse results', () => {
        const out = run(3, report(), parsed({}, { starts: 1, ends: 2 }));
        expect(out.snappedStarts).toBe(3);
        expect(out.snappedEnds).toBe(6);
    });
});

describe('aggregateRun — the buckets', () => {
    it('the fan-out counters, sourceless and outsideFixture are sums', () => {
        const r = report({ multiSourceSupports: 1, choiceSupports: 2, pickDifferedFromFirst: 3, partialSupports: 4, sourceless: 5, outsideFixture: 6 });
        const b = run(2, r).buckets;
        expect([b.multiSourceSupports, b.choiceSupports, b.pickDifferedFromFirst, b.partialSupports, b.sourceless, b.outsideFixture]).toEqual([2, 4, 6, 8, 10, 12]);
    });

    it('notLocated: byDocument holds only fixture documents, and an origin outside the fixture or unresolved is unmatched', () => {
        const r = report({
            notLocated: [
                { documentId: 'A', resolvedBy: 'customMetadata', inFixture: true },
                { documentId: 'A', resolvedBy: 'title', inFixture: true },
                { documentId: 'B', resolvedBy: 'title', inFixture: false },
                { documentId: null, resolvedBy: null, inFixture: false },
            ],
        });
        // 2 unmatched of 4 is above the ratio: the breakdown is withheld.
        const withheld = run(1, r).buckets.notLocated;
        expect(withheld.count).toBe(4);
        expect(withheld.unmatchedDocument).toBe(2);
        expect(withheld.byDocument).toBeNull();
        expect(withheld.resolvedBy).toEqual({ customMetadata: 1, title: 2 });

        // Dilute with in-fixture origins until the ratio holds: 2 of 40 is 0.05.
        const inFixture = report({ notLocated: Array(36).fill({ documentId: 'A', resolvedBy: 'title', inFixture: true }) });
        const held = aggregateRun([r, inFixture], [parsed(), parsed()], [fixture(), fixture()], META).buckets.notLocated;
        expect(held.byDocument).toEqual({ A: 38 });
        expect(Object.keys(held.byDocument!)).not.toContain('B');
    });

    it('the ratio gate is inclusive at the threshold', () => {
        // 1 unmatched of 10 is exactly MAX_UNMATCHED_DOCUMENT_RATIO.
        const total = Math.round(1 / MAX_UNMATCHED_DOCUMENT_RATIO);
        const origins = [{ documentId: null, resolvedBy: null, inFixture: false } as const, ...Array(total - 1).fill({ documentId: 'A', resolvedBy: 'title', inFixture: true })];
        const out = run(1, report({ notLocated: origins }));
        expect(out.buckets.notLocated.byDocument).toEqual({ A: total - 1 });
    });

    it('resolvedBy counts every resolved origin, inside the fixture or not: it is instrumentation and is not gated', () => {
        const r = report({ notLocated: [{ documentId: 'B', resolvedBy: 'customMetadata', inFixture: false }] });
        const out = run(1, r).buckets.notLocated;
        expect(out.byDocument).toBeNull();
        expect(out.resolvedBy).toEqual({ customMetadata: 1, title: 0 });
    });

    it('ambiguous: same-document and across-document are complementary, and byDocument sums the documents each ambiguity lists', () => {
        // The scorer lists each document once per ambiguity; this is that shape.
        const r = report({
            ambiguous: [
                { sameDocument: true, documentIds: ['A'] },
                { sameDocument: false, documentIds: ['A', 'B'] },
                { sameDocument: false, documentIds: ['B', 'C'] },
            ],
        });
        const b = run(1, r).buckets.ambiguous;
        expect(b.count).toBe(3);
        expect(b.sameDocument).toBe(1);
        expect(b.acrossDocuments).toBe(2);
        expect(b.byDocument).toEqual({ A: 2, B: 2, C: 1 });
    });
});
