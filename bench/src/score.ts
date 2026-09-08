/**
 * A citation is scored against the gold span of the segment it belongs to,
 * and the report carries the denominators.
 *
 * This is the pure half of the ruler: given one labeled response and the
 * citation candidates the parser extracted from the emitter's raw output, it
 * produces counts, sums and distributions — never a rate. A rate per response
 * cannot be averaged into the rate of a run (two citations would weigh as much
 * as forty), so every axis leaves here as a numerator and a denominator and the
 * aggregator divides.
 *
 * The four legs of the score, each a decision that two implementers would
 * otherwise take differently:
 *
 *   - UNIT: one marker in the response is one citation, however many chunks
 *     it points at. Among the sources that were located, the one with the
 *     greatest overlap against the segment's gold is the one scored — a
 *     declared, generous reading, and the counters `multiSourceSupports`,
 *     `choiceSupports` and `pickDifferedFromFirst` say how often it mattered.
 *   - FUNCTION: `overlap = 0` when the documents differ; otherwise
 *     `max(|∩|/|gold|, |∩|/|cited|)`. Not IoU: a whole-chunk citation that
 *     contains the gold sentence points at the right place, and so does a
 *     narrow one inside it. Coarseness is measured separately, as
 *     `|cited|/|gold|`, and published as a distribution.
 *   - THRESHOLD: correct when `overlap >= threshold`. The default is arbitrary
 *     until calibrated, and the distribution is published so anyone can
 *     recompute with another.
 *   - MATCHING: a citation belongs to the labeled segment of the same Part
 *     whose intersection with its text span is greatest (ties → the earlier
 *     segment); no intersection means it cites something unsupported and is
 *     wrong. It is correct if it reaches the threshold against ANY gold span
 *     of that segment.
 *
 * Coverage has three states per segment. Covered: at least one correct
 * citation. Indeterminate: every marker on it fell in a bucket (text the
 * emitter altered, repeated text, a marker with no source at all) — that is
 * neutral for precision and must not turn negative for coverage through the
 * back door, so the segment leaves the denominator. Uncovered otherwise.
 *
 * Passages are classified by COVERAGE, not presence: the fraction of an
 * interval's code points that fall inside each kind of protected region of
 * its document. A 700-code-point chunk holding a 20-code-point formula weighs
 * 0.03 in `formula`; it is not "a formula chunk". Gold spans, scored spans and
 * ambiguous occurrences have positions and are measured against the
 * document's regions, which arrive ready-made in the corpus. A snippet that
 * was not located has no position, so it is measured against its own regions
 * — the one piece of masking this module does itself, and the weakest of the
 * four columns, since the snippet may be the altered text.
 *
 * ASSUMED of the caller: every span in the fixture and in the located sources
 * has `end > start`. The fixture schema enforces it for gold and text spans;
 * the locator produces it for located snippets. The one interval nobody
 * guarantees — an unlocated snippet's own length — is guarded inside.
 */

import type { Span } from '../../src/types.js';
import { countCodePoints } from '../../src/unicode.js';
import { maskProtectedRegions, type ProtectedSpan } from '../../src/mask.js';
import type { MaskedCorpus } from './corpus.js';
import type { LocateResult, Occurrence } from './locate.js';
import type { ResolvedOrigin } from './origin.js';

/** Arbitrary until calibrated by a real run; the overlap distribution is published for recomputation. */
export const DEFAULT_CITATION_OVERLAP_THRESHOLD = 0.5;

/** The kinds the package's mask reports, plus what is outside every region. */
export type PassageClass = ProtectedSpan['kind'] | 'plain';

/**
 * Zero of every class. Typed as `ClassMass`, so a new region kind in the
 * package fails the typecheck here — and `PASSAGE_CLASSES` is derived from
 * it, so the list cannot fall behind the type while still compiling.
 */
const EMPTY_MASS: ClassMass = { code: 0, url: 0, formula: 0, abbreviation: 0, plain: 0 };
export const PASSAGE_CLASSES: readonly PassageClass[] = Object.keys(EMPTY_MASS) as PassageClass[];

export interface CitationSource {
    readonly located: LocateResult;
    readonly origin: ResolvedOrigin;
}

/** A source whose snippet was located: the only kind that can be scored. */
type LocatedSource = CitationSource & { readonly located: { readonly kind: 'exact' } & Occurrence };

function isLocated(source: CitationSource): source is LocatedSource {
    return source.located.kind === 'exact';
}

/** One marker of the response, as the parser hands it over. */
export interface CitationCandidate {
    readonly partIndex: number;
    /** Code points into the text of that Part. */
    readonly textSpan: Span;
    /** How many chunk indices the emitter attached, before any were discarded for lacking text. */
    readonly rawChunkCount: number;
    /** One per chunk index that had text, in the emitter's order. Empty means the marker has no source. */
    readonly sources: readonly CitationSource[];
}

export interface LabeledSegment {
    readonly partIndex: number;
    /** Code points into `parts[partIndex].text`. */
    readonly textSpan: Span;
    readonly sourceSpans: readonly { readonly documentId: string; readonly span: Span }[];
}

export interface LabeledFixture {
    readonly id: string;
    readonly parts: readonly { readonly text: string }[];
    /** The supported stretches of the response. Anything outside them is unsupported. */
    readonly segments: readonly LabeledSegment[];
    readonly labeledBy: string;
    readonly labeledAt: string;
}

export type ClassMass = Readonly<Record<PassageClass, number>>;

export interface ScoreReport {
    readonly citationsCorrect: number;
    /** Markers with at least one located source. */
    readonly citationsScored: number;
    readonly segmentsCovered: number;
    /** Net of the indeterminate ones. `segmentsSustained + segmentsIndeterminate === segments.length`. */
    readonly segmentsSustained: number;
    readonly segmentsIndeterminate: number;
    /** One entry per scored marker. */
    readonly overlapDistribution: readonly number[];
    /** Only for markers with `overlap > 0`: `|cited| / |gold|` against the gold that produced it. */
    readonly granularityDistribution: readonly number[];
    /** Divisor of `goldClassMass`: every gold span of every segment. */
    readonly goldSpanCount: number;
    readonly goldClassMass: ClassMass;
    /** Summed over scored markers; divide by `citationsScored`. */
    readonly scoredClassMass: ClassMass;
    /** Summed over ambiguous sources, one occurrence each; divide by `ambiguous.length`. */
    readonly ambiguousClassMass: ClassMass;
    /** Summed over unlocated snippets, measured on the snippet itself; divide by `notLocated.length`. */
    readonly notLocatedClassMass: ClassMass;
    /** Markers the emitter attached more than one chunk to. */
    readonly multiSourceSupports: number;
    /** Scored markers with two or more located sources — where a choice existed. */
    readonly choiceSupports: number;
    /** Of those, how many were scored by a source other than the first located one. */
    readonly pickDifferedFromFirst: number;
    /** Markers with sources whose set was reduced: a chunk without text, or a source that fell in a bucket beside a located one. */
    readonly partialSupports: number;
    /** Markers with no source at all. Outside every other count. */
    readonly sourceless: number;
    /**
     * Scored markers whose chosen source lies in a document outside the
     * fixture. Counted as wrong above; this is transparency. When no located
     * source touches the gold, the "chosen" one is the first in the emitter's
     * order, and this counter follows it — the unit is the marker, not the
     * source, so a marker with one source inside and one outside, both missing
     * the gold, is reported by whichever the emitter listed first.
     */
    readonly outsideFixture: number;
    /** The origin the parser attached to each unlocated source. Never the snippet. */
    readonly notLocated: readonly ResolvedOrigin[];
    /** How many gold spans have any mass in each class. */
    readonly goldSpansByClass: ClassMass;
    readonly ambiguous: readonly { readonly sameDocument: boolean; readonly documentIds: readonly string[] }[];
}

function intersection(a: Span, b: Span): number {
    return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function length(s: Span): number {
    return s.end - s.start;
}

/**
 * The fraction of `span` covered by each kind of region; `plain` is what no
 * region covers. A zero-length interval has no class at all and contributes
 * nothing: dividing by its length would put NaN into a sum that no divisor
 * downstream can recover. Gold and cited spans are non-empty by the fixture
 * schema; an unlocated snippet is not covered by any schema and can be empty.
 */
function classMassOf(regions: readonly ProtectedSpan[], span: Span): ClassMass {
    const total = length(span);
    if (total === 0) return EMPTY_MASS;
    const mass: Record<PassageClass, number> = { ...EMPTY_MASS };
    let covered = 0;
    for (const r of regions) {
        const shared = intersection(r, span);
        if (shared === 0) continue;
        mass[r.kind] += shared / total;
        covered += shared;
    }
    mass.plain = (total - covered) / total;
    return mass;
}

function addMass(into: Record<PassageClass, number>, mass: ClassMass): void {
    for (const k of PASSAGE_CLASSES) into[k] += mass[k];
}

function overlapOf(cited: { documentId: string; span: Span }, gold: { documentId: string; span: Span }): number {
    if (cited.documentId !== gold.documentId) return 0;
    const shared = intersection(cited.span, gold.span);
    if (shared === 0) return 0;
    return Math.max(shared / length(gold.span), shared / length(cited.span));
}

/** The segment a marker belongs to: same Part, greatest intersection, earlier start on a tie; or none. */
function segmentOf(labeled: LabeledFixture, candidate: CitationCandidate): number | null {
    let best: number | null = null;
    let bestShared = 0;
    labeled.segments.forEach((segment, i) => {
        if (segment.partIndex !== candidate.partIndex) return;
        const shared = intersection(segment.textSpan, candidate.textSpan);
        if (shared === 0) return;
        const earlier = best !== null && segment.textSpan.start < labeled.segments[best]!.textSpan.start;
        if (shared > bestShared || (shared === bestShared && earlier)) {
            best = i;
            bestShared = shared;
        }
    });
    return best;
}

/**
 * Scores one labeled response. `corpus` is the ROUND map: a chosen source may
 * lie outside the fixture, and its document must still be found to measure
 * its class. A document absent from the map is treated as having no regions.
 */
export function scoreResponse(
    labeled: LabeledFixture,
    citations: readonly CitationCandidate[],
    corpus: MaskedCorpus,
    threshold: number = DEFAULT_CITATION_OVERLAP_THRESHOLD,
): ScoreReport {
    const regionsOf = (documentId: string): readonly ProtectedSpan[] => corpus.get(documentId)?.regions ?? [];

    // Gold side: the denominators of the class analysis.
    let goldSpanCount = 0;
    const goldClassMass: Record<PassageClass, number> = { ...EMPTY_MASS };
    const goldSpansByClass: Record<PassageClass, number> = { ...EMPTY_MASS };
    for (const segment of labeled.segments) {
        for (const gold of segment.sourceSpans) {
            goldSpanCount++;
            const mass = classMassOf(regionsOf(gold.documentId), gold.span);
            addMass(goldClassMass, mass);
            for (const k of PASSAGE_CLASSES) if (mass[k] > 0) goldSpansByClass[k]++;
        }
    }

    // Per segment: did any correct citation land on it, and did every marker on it fall in a bucket?
    const correctOn = new Array<boolean>(labeled.segments.length).fill(false);
    const touchedOn = new Array<number>(labeled.segments.length).fill(0);
    const bucketOnlyOn = new Array<number>(labeled.segments.length).fill(0);

    let citationsCorrect = 0;
    let citationsScored = 0;
    const overlapDistribution: number[] = [];
    const granularityDistribution: number[] = [];
    const scoredClassMass: Record<PassageClass, number> = { ...EMPTY_MASS };
    const ambiguousClassMass: Record<PassageClass, number> = { ...EMPTY_MASS };
    const notLocatedClassMass: Record<PassageClass, number> = { ...EMPTY_MASS };
    let multiSourceSupports = 0;
    let choiceSupports = 0;
    let pickDifferedFromFirst = 0;
    let partialSupports = 0;
    let sourceless = 0;
    let outsideFixture = 0;
    const notLocated: ResolvedOrigin[] = [];
    const ambiguous: { sameDocument: boolean; documentIds: string[] }[] = [];

    for (const candidate of citations) {
        const segmentIndex = segmentOf(labeled, candidate);
        if (segmentIndex !== null) touchedOn[segmentIndex]!++;

        if (candidate.rawChunkCount > 1) multiSourceSupports++;

        if (candidate.sources.length === 0) {
            sourceless++;
            if (segmentIndex !== null) bucketOnlyOn[segmentIndex]!++;
            continue;
        }

        // Buckets are recorded per source, whatever happens to the marker.
        for (const source of candidate.sources) {
            const located = source.located;
            if (located.kind === 'not_found') {
                notLocated.push(source.origin);
                const snippetSpan = { start: 0, end: countCodePoints(located.snippet) };
                addMass(notLocatedClassMass, classMassOf(maskProtectedRegions(located.snippet).spans, snippetSpan));
            } else if (located.kind === 'ambiguous') {
                const ids = [...new Set(located.occurrences.map((o) => o.documentId))];
                ambiguous.push({ sameDocument: ids.length === 1, documentIds: ids });
                const first = located.occurrences[0]!;
                addMass(ambiguousClassMass, classMassOf(regionsOf(first.documentId), first.span));
            }
        }

        const exact = candidate.sources.filter(isLocated);
        // "Partial" presupposes that something was located: a marker whose
        // sources all fell in buckets is a bucket, not a partial success, even
        // when a chunk was discarded on the way. With at least one located
        // source, the set was reduced if a chunk lacked text or a sibling fell
        // in a bucket.
        const reduced = exact.length > 0 && (candidate.rawChunkCount > candidate.sources.length || exact.length < candidate.sources.length);
        if (reduced) partialSupports++;

        if (exact.length === 0) {
            if (segmentIndex !== null) bucketOnlyOn[segmentIndex]!++;
            continue;
        }

        citationsScored++;
        if (exact.length >= 2) choiceSupports++;

        // Choose the located source with the greatest overlap against the segment's gold;
        // ties keep the earlier one in the emitter's order.
        const golds = segmentIndex === null ? [] : labeled.segments[segmentIndex]!.sourceSpans;
        let chosen = exact[0]!;
        let bestOverlap = 0;
        let bestGold: { documentId: string; span: Span } | null = null;
        for (const source of exact) {
            for (const gold of golds) {
                const o = overlapOf(source.located, gold);
                if (o > bestOverlap) {
                    bestOverlap = o;
                    chosen = source;
                    bestGold = gold;
                }
            }
        }
        if (chosen !== exact[0]) pickDifferedFromFirst++;

        const chosenSpan = chosen.located;
        overlapDistribution.push(bestOverlap);
        if (bestOverlap > 0 && bestGold !== null) {
            granularityDistribution.push(length(chosenSpan.span) / length(bestGold.span));
        }
        addMass(scoredClassMass, classMassOf(regionsOf(chosenSpan.documentId), chosenSpan.span));
        if (chosen.origin.inFixture === false) outsideFixture++;

        if (bestOverlap >= threshold && segmentIndex !== null) {
            citationsCorrect++;
            correctOn[segmentIndex] = true;
        }
    }

    let segmentsCovered = 0;
    let segmentsIndeterminate = 0;
    labeled.segments.forEach((_, i) => {
        if (correctOn[i]) segmentsCovered++;
        else if (touchedOn[i]! > 0 && bucketOnlyOn[i] === touchedOn[i]) segmentsIndeterminate++;
    });

    return {
        citationsCorrect,
        citationsScored,
        segmentsCovered,
        segmentsSustained: labeled.segments.length - segmentsIndeterminate,
        segmentsIndeterminate,
        overlapDistribution,
        granularityDistribution,
        goldSpanCount,
        goldClassMass,
        scoredClassMass,
        ambiguousClassMass,
        notLocatedClassMass,
        multiSourceSupports,
        choiceSupports,
        pickDifferedFromFirst,
        partialSupports,
        sourceless,
        outsideFixture,
        notLocated,
        goldSpansByClass,
        ambiguous,
    };
}
