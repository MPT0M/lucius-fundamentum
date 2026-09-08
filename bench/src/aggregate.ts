/**
 * One round becomes one report, and the report is the table the README
 * carries — field by field, with no parallel list to drift from it.
 *
 * The aggregator is pure: the per-response score reports, the per-response
 * parse results and the raw fixtures of the round in, `BenchmarkRunReport`
 * out. No rate is averaged across responses — a rate per response cannot be
 * averaged into the rate of a run. The two axes leave as numerator and
 * denominator, as the plan fixes them, for the table to divide; every division
 * the report does contain — the class columns and their ratio — happens here,
 * once. Six fields are born here and nowhere earlier, which is why this module
 * has its own test: `googleActivation`, `emptyMetadata`,
 * `lengthDeltaAllPlusOne`, `metaMismatch`, and the two gates, `publishable`
 * and `sampleSufficient`.
 *
 * The two gates are separate on purpose. `publishable` says the instrument
 * held: no position failure, no Part missing, no field missing, no length
 * mismatch, and every fixture recorded under the model and store the header
 * names — a number published under a header its fixtures do not match is a
 * claim with no validity. `sampleSufficient` says there was enough to count.
 * A broken instrument asks for a fix and a new round; a small sample asks for
 * plan B. Collapsing the two into one boolean would erase the information that
 * decides the path.
 *
 * Where the per-response fields hold both spellings of the activation counter
 * — the SDK emits camelCase, a raw fetch emits snake_case — the reading is
 * done in one place, `toolUsePromptTokens`, and absent in both means 0: the
 * search did not run, which is a measurement of the emitter, not a failure of
 * the recording.
 *
 * A column that averages over an empty set — no ambiguous source in the whole
 * round, say — reports 0 in every class. The counts published beside it
 * (`ambiguous.count`, `notLocated.count`, `precision.scored`, `goldSpans`) say
 * whether a 0 is a measured absence or an empty column; the table's legend
 * points at them.
 *
 * ASSUMED of the caller: each `ambiguous` entry lists a document once, and its
 * `sameDocument` agrees with that list — the scorer builds both from one set.
 * Neither is recomputed here.
 */

import type { GoogleRawFixture } from './fixture.js';
import type { ParseResult } from './parse.js';
import { PASSAGE_CLASSES, type ClassMass, type PassageClass, type ScoreReport } from './score.js';

/**
 * Below this many scored citations the round is not a comparison but a call
 * for plan B. Arbitrary and declared, like the overlap threshold.
 */
export const MIN_SCORED_CITATIONS = 100;

/**
 * Above this share of unlocated snippets whose document could not be
 * resolved to the fixture, the per-document breakdown is withheld: a
 * composition that is one tenth guesswork must not wear the typography of a
 * measured number. Arbitrary and declared.
 */
export const MAX_UNMATCHED_DOCUMENT_RATIO = 0.1;

/** Who and what was measured. The header of the published table. */
export interface RunMeta {
    readonly model: string;
    readonly recordedAt: string;
    readonly reportVersion: string;
    readonly storeEmbeddingModel: string;
    readonly storeChunking: { readonly maxTokensPerChunk: number; readonly maxOverlapTokens: number };
    /** Our side of the identification. `null` until the provider exists. */
    readonly providerId: string | null;
    readonly formatVersion: number | null;
}

export interface ClassColumn {
    /** Mean fraction of gold spans covered by this class. */
    readonly gold: number;
    /** Mean fraction of scored citations covered by this class. */
    readonly scored: number;
    /** Mean fraction of ambiguous occurrences covered by this class. */
    readonly ambiguous: number;
    /**
     * Mean fraction of unlocated snippets covered by this class, measured on
     * the snippet itself. UNDER-REPORTS `code` and `formula` by construction:
     * a fenced block needs both fences and a formula both delimiters, and a
     * snippet cut in the middle of one has only one. A 0 here does not say
     * "there was no code".
     */
    readonly notLocated: number;
    /** `scored / gold`; `null` when the class has no mass in the gold. */
    readonly scoredOverGold: number | null;
    /** How many gold spans carry any mass in this class — the sample the ratio rests on. */
    readonly goldSpans: number;
}

export interface BenchmarkRunReport {
    readonly model: string;
    readonly recordedAt: string;
    readonly reportVersion: string;
    readonly storeEmbeddingModel: string;
    readonly storeChunking: { readonly maxTokensPerChunk: number; readonly maxOverlapTokens: number };
    readonly providerId: string | null;
    readonly formatVersion: number | null;
    readonly responses: number;
    /** Sums; the rate is `correct / scored`. */
    readonly precision: { readonly correct: number; readonly scored: number };
    /** Sums of the NET fields of the score reports; the rate is `covered / sustained`. */
    readonly coverage: { readonly covered: number; readonly sustained: number };
    /** Responses whose recording says the search ran, over all responses. The emitter's side; there is no ours. */
    readonly googleActivation: { readonly toolUsed: number; readonly of: number };
    readonly overlapDistribution: readonly number[];
    readonly granularityDistribution: readonly number[];
    readonly byClass: Readonly<Record<PassageClass, ClassColumn>>;
    readonly snappedStarts: number;
    readonly snappedEnds: number;
    readonly parseViolations: {
        readonly length: number;
        readonly position: number;
        readonly missingPart: number;
        readonly missingField: number;
        /** Every length failure is exactly +1: the end is inclusive, the rule changes and the round is reprocessed. */
        readonly lengthDeltaAllPlusOne: boolean;
    };
    /** `precision.scored >= MIN_SCORED_CITATIONS`. A gate apart from `publishable`. */
    readonly sampleSufficient: boolean;
    /** Fixtures whose model or store differs from `meta`. */
    readonly metaMismatch: number;
    /** The instrument held: no position, Part, field or length failure, and every fixture matches the header. */
    readonly publishable: boolean;
    readonly buckets: {
        /** Responses where the search ran and no grounding came back. */
        readonly emptyMetadata: number;
        /** Markers with no source at all. Outside every axis: a defect of the emitter, published as such. */
        readonly sourceless: number;
        /** Scored citations that pointed at a document outside the fixture. Counted as wrong; this is transparency. */
        readonly outsideFixture: number;
        readonly multiSourceSupports: number;
        readonly choiceSupports: number;
        readonly pickDifferedFromFirst: number;
        readonly partialSupports: number;
        readonly notLocated: {
            readonly count: number;
            /** Only keys from the fixture; `null` when `unmatchedDocument / count` exceeds the ratio. */
            readonly byDocument: Readonly<Record<string, number>> | null;
            /** Unlocated snippets whose origin did not resolve to the fixture. */
            readonly unmatchedDocument: number;
            /** Which hint resolved. Instrumentation, not a result: it is not gated. */
            readonly resolvedBy: { readonly customMetadata: number; readonly title: number };
        };
        readonly ambiguous: {
            readonly count: number;
            readonly sameDocument: number;
            readonly acrossDocuments: number;
            /** Each document an ambiguity touched. The scorer lists a document once per ambiguity. */
            readonly byDocument: Readonly<Record<string, number>>;
        };
        readonly indeterminateSegments: number;
    };
}

/** The one reading of the activation counter, in either spelling. Absent in both means the search did not run. */
function toolUsePromptTokens(fixture: GoogleRawFixture): number {
    return fixture.usageMetadata.toolUsePromptTokenCount ?? fixture.usageMetadata.tool_use_prompt_token_count ?? 0;
}

function hasGrounding(fixture: GoogleRawFixture): boolean {
    const metadata = fixture.groundingMetadata;
    if (metadata === undefined) return false;
    return (metadata.groundingChunks?.length ?? 0) > 0 || (metadata.groundingSupports?.length ?? 0) > 0;
}

function matchesMeta(fixture: GoogleRawFixture, meta: RunMeta): boolean {
    return (
        fixture.model === meta.model &&
        fixture.storeEmbeddingModel === meta.storeEmbeddingModel &&
        fixture.storeChunking.maxTokensPerChunk === meta.storeChunking.maxTokensPerChunk &&
        fixture.storeChunking.maxOverlapTokens === meta.storeChunking.maxOverlapTokens
    );
}

function sum(values: readonly number[]): number {
    return values.reduce((acc, v) => acc + v, 0);
}

function sumMass(masses: readonly ClassMass[]): ClassMass {
    const total = Object.fromEntries(PASSAGE_CLASSES.map((k) => [k, 0])) as Record<PassageClass, number>;
    for (const mass of masses) for (const k of PASSAGE_CLASSES) total[k] += mass[k];
    return total;
}

function meanOrZero(total: number, count: number): number {
    return count === 0 ? 0 : total / count;
}

function increment(counts: Record<string, number>, key: string): void {
    counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Aggregates one round. The three arrays are parallel — entry `i` of each
 * describes the same response — and a length mismatch is a caller's error,
 * refused before any number is produced.
 */
export function aggregateRun(
    reports: readonly ScoreReport[],
    parsed: readonly ParseResult[],
    fixtures: readonly GoogleRawFixture[],
    meta: RunMeta,
): BenchmarkRunReport {
    if (reports.length !== parsed.length || reports.length !== fixtures.length) {
        throw new RangeError(
            `aggregateRun needs parallel arrays: ${reports.length} reports, ${parsed.length} parse results, ${fixtures.length} fixtures`,
        );
    }

    const scored = sum(reports.map((r) => r.citationsScored));
    const goldSpanCount = sum(reports.map((r) => r.goldSpanCount));
    const ambiguousCount = sum(reports.map((r) => r.ambiguous.length));
    const notLocatedCount = sum(reports.map((r) => r.notLocated.length));

    const goldMass = sumMass(reports.map((r) => r.goldClassMass));
    const scoredMass = sumMass(reports.map((r) => r.scoredClassMass));
    const ambiguousMass = sumMass(reports.map((r) => r.ambiguousClassMass));
    const notLocatedMass = sumMass(reports.map((r) => r.notLocatedClassMass));
    const goldSpansByClass = sumMass(reports.map((r) => r.goldSpansByClass));

    const byClass = {} as Record<PassageClass, ClassColumn>;
    for (const k of PASSAGE_CLASSES) {
        const gold = meanOrZero(goldMass[k], goldSpanCount);
        const scoredFraction = meanOrZero(scoredMass[k], scored);
        byClass[k] = {
            gold,
            scored: scoredFraction,
            ambiguous: meanOrZero(ambiguousMass[k], ambiguousCount),
            notLocated: meanOrZero(notLocatedMass[k], notLocatedCount),
            scoredOverGold: gold === 0 ? null : scoredFraction / gold,
            goldSpans: goldSpansByClass[k],
        };
    }

    const lengthDeltas = parsed.flatMap((p) => p.violations.length.map((v) => v.lengthDelta));
    const parseViolations = {
        length: lengthDeltas.length,
        position: sum(parsed.map((p) => p.violations.position.length)),
        missingPart: sum(parsed.map((p) => p.violations.missingPart.length)),
        missingField: sum(parsed.map((p) => p.violations.missingField.length)),
        lengthDeltaAllPlusOne: lengthDeltas.length > 0 && lengthDeltas.every((d) => d === 1),
    };

    const metaMismatch = fixtures.filter((f) => !matchesMeta(f, meta)).length;
    const publishable =
        parseViolations.length === 0 &&
        parseViolations.position === 0 &&
        parseViolations.missingPart === 0 &&
        parseViolations.missingField === 0 &&
        metaMismatch === 0;

    const toolUsed = fixtures.filter((f) => toolUsePromptTokens(f) > 0);

    const notLocatedByDocument: Record<string, number> = {};
    let unmatchedDocument = 0;
    const resolvedBy = { customMetadata: 0, title: 0 };
    for (const origin of reports.flatMap((r) => r.notLocated)) {
        if (origin.resolvedBy !== null) resolvedBy[origin.resolvedBy]++;
        if (origin.documentId === null || !origin.inFixture) {
            unmatchedDocument++;
            continue;
        }
        increment(notLocatedByDocument, origin.documentId);
    }
    const documentAttributionHeld = notLocatedCount === 0 || unmatchedDocument / notLocatedCount <= MAX_UNMATCHED_DOCUMENT_RATIO;

    const ambiguousByDocument: Record<string, number> = {};
    let sameDocument = 0;
    for (const entry of reports.flatMap((r) => r.ambiguous)) {
        if (entry.sameDocument) sameDocument++;
        for (const id of entry.documentIds) increment(ambiguousByDocument, id);
    }

    return {
        model: meta.model,
        recordedAt: meta.recordedAt,
        reportVersion: meta.reportVersion,
        storeEmbeddingModel: meta.storeEmbeddingModel,
        storeChunking: meta.storeChunking,
        providerId: meta.providerId,
        formatVersion: meta.formatVersion,
        responses: fixtures.length,
        precision: { correct: sum(reports.map((r) => r.citationsCorrect)), scored },
        coverage: {
            covered: sum(reports.map((r) => r.segmentsCovered)),
            sustained: sum(reports.map((r) => r.segmentsSustained)),
        },
        googleActivation: { toolUsed: toolUsed.length, of: fixtures.length },
        overlapDistribution: reports.flatMap((r) => r.overlapDistribution),
        granularityDistribution: reports.flatMap((r) => r.granularityDistribution),
        byClass,
        snappedStarts: sum(parsed.map((p) => p.snappedStarts)),
        snappedEnds: sum(parsed.map((p) => p.snappedEnds)),
        parseViolations,
        sampleSufficient: scored >= MIN_SCORED_CITATIONS,
        metaMismatch,
        publishable,
        buckets: {
            emptyMetadata: toolUsed.filter((f) => !hasGrounding(f)).length,
            sourceless: sum(reports.map((r) => r.sourceless)),
            outsideFixture: sum(reports.map((r) => r.outsideFixture)),
            multiSourceSupports: sum(reports.map((r) => r.multiSourceSupports)),
            choiceSupports: sum(reports.map((r) => r.choiceSupports)),
            pickDifferedFromFirst: sum(reports.map((r) => r.pickDifferedFromFirst)),
            partialSupports: sum(reports.map((r) => r.partialSupports)),
            notLocated: {
                count: notLocatedCount,
                byDocument: documentAttributionHeld ? notLocatedByDocument : null,
                unmatchedDocument,
                resolvedBy,
            },
            ambiguous: {
                count: ambiguousCount,
                sameDocument,
                acrossDocuments: ambiguousCount - sameDocument,
                byDocument: ambiguousByDocument,
            },
            indeterminateSegments: sum(reports.map((r) => r.segmentsIndeterminate)),
        },
    };
}
