/**
 * The raw response becomes citation candidates, and its violations are
 * counted.
 *
 * This is the adapter between what the emitter recorded and what the scorer
 * reads, and it is pure: a fixture already on disk plus the corpus in, a list
 * of candidates and a tally of violations out. It is kept out of the runner on
 * purpose — the runner needs a key and the network and never enters the test
 * suite, so anything that lived there would be checked by nothing. The three
 * assertions the whole ruler leans on live here, where a test can watch them:
 *
 *   (1) `utf8ByteLength(segment.text) === endIndex - startIndex` — the
 *       hypothesis that `endIndex` is exclusive. If it fails by +1 on every
 *       segment, the end is inclusive and the rule changes; mixed signs are
 *       noise. The sign of each failure is kept so the aggregator can tell.
 *   (2) `sliceByCodePoints(part.text, start, end) === segment.text` — the
 *       converted span selects the text the emitter says it marked. This is
 *       the position check, per sample.
 *   (3) every `partIndex` names a Part that exists.
 *
 * A failed assertion is recorded, not thrown: the round decides whether it is
 * publishable from the tally, and a broken instrument must be visible in the
 * report, not in a stack trace.
 *
 * What an absent field means is decided HERE, per field. Protobuf drops
 * defaults, so `partIndex` and `startIndex` absent mean 0 — the span that opens
 * the answer is the most common citation there is — and `groundingChunkIndices`
 * absent means no source. Only `endIndex` and `segment.text` have no useful
 * default: an absent end would mean the empty interval, and without the text
 * nothing can be checked. Those two are the `missingField` violation. The
 * rule is about the ABSENCE of the field: an explicit `endIndex` equal to
 * `startIndex` with an empty `text` passes the three assertions and emits a
 * zero-length candidate; the scorer matches it to no segment — an empty
 * interval intersects nothing — and scores it with overlap zero if it has a
 * located source.
 *
 * Sources: one entry per chunk index whose chunk has text, in the emitter's
 * order. A chunk without text is discarded — that index contributes nothing —
 * and a marker whose every index was discarded has no source at all. For each
 * source the document of origin is resolved FIRST, from the hints the emitter
 * returned, against the round map; then the snippet is located in the
 * fixture's view. A source whose origin resolved to a document outside the
 * fixture is located in that document instead, so that the scorer can count
 * the citation as pointing at the wrong document rather than lose it.
 */

import { sliceByCodePoints } from '../../src/unicode.js';
import type { MaskedCorpus, MaskedDocument } from './corpus.js';
import { locateSnippet, type LocateResult } from './locate.js';
import type { ResolvedOrigin } from './origin.js';
import type { CitationCandidate, CitationSource } from './score.js';
import { byteOffsetToCodePoint, utf8ByteLength } from './utf8.js';
import type { GoogleRawChunk, GoogleRawFixture } from './fixture.js';

/** What the emitter said about a chunk's document, before matching. */
export interface DocumentHint {
    readonly title: string | null;
    readonly customDocumentId: string | null;
}

export interface ParseViolations {
    /** Assertion (1) failures, with `(endIndex - startIndex) - utf8ByteLength(text)`. */
    readonly length: readonly { readonly segment: number; readonly lengthDelta: number }[];
    /** Assertion (2) failures: the converted span does not select the segment text. */
    readonly position: readonly number[];
    /** Assertion (3) failures: `partIndex` names no Part. */
    readonly missingPart: readonly number[];
    /** Fields with no useful default that were absent. */
    readonly missingField: readonly { readonly segment: number; readonly field: 'endIndex' | 'segment.text' }[];
}

export interface ParseResult {
    /**
     * `textSpan` is `[start, end)` as converted from the emitter's offsets, in
     * the emitter's order: an `endIndex` below `startIndex` yields an inverted
     * span. The assertions catch it — the slice of an inverted interval is
     * empty — and it is left to the scorer, whose intersections clamp at zero.
     */
    readonly candidates: readonly CitationCandidate[];
    readonly snappedStarts: number;
    readonly snappedEnds: number;
    readonly violations: ParseViolations;
}

/**
 * The fixture's view of the round: the same map, restricted to the documents
 * the fixture was generated from. An id the round does not have is a manifest
 * inconsistency and is refused by name.
 */
export function viewOf(round: MaskedCorpus, derivedFrom: readonly string[]): MaskedCorpus {
    const view = new Map<string, MaskedDocument>();
    for (const id of derivedFrom) {
        const doc = round.get(id);
        if (doc === undefined) throw new RangeError(`derivedFrom names "${id}", which the round corpus does not have`);
        view.set(id, doc);
    }
    return view;
}

/**
 * Pulls the two hints out of a chunk. Pure, so the shape hypothesis has one
 * home. Accepts `undefined` because the caller reaches the chunk by index
 * (`chunks[index]`) and an index the emitter got wrong is a chunk that is not
 * there — not because a chunk is optional in the domain.
 */
export function hintOf(chunk: GoogleRawChunk | undefined): DocumentHint {
    const ctx = chunk?.retrievedContext;
    const custom = ctx?.customMetadata?.find((m) => m.key === 'documentId')?.stringValue;
    return { title: ctx?.title ?? null, customDocumentId: custom ?? null };
}

/**
 * Matches the hints against the round map by identity — we upload both the
 * display name and the custom metadata as the manifest's `documentId`, so
 * matching is a lookup, not a heuristic. Custom metadata first, the title
 * second; which one resolved is kept, because the first real run has to learn
 * which field the emitter actually returns.
 */
export function resolveOrigin(hint: DocumentHint, round: MaskedCorpus, view: MaskedCorpus): ResolvedOrigin {
    if (hint.customDocumentId !== null && round.has(hint.customDocumentId)) {
        return { documentId: hint.customDocumentId, resolvedBy: 'customMetadata', inFixture: view.has(hint.customDocumentId) };
    }
    if (hint.title !== null && round.has(hint.title)) {
        return { documentId: hint.title, resolvedBy: 'title', inFixture: view.has(hint.title) };
    }
    return { documentId: null, resolvedBy: null, inFixture: false };
}

function locateFor(origin: ResolvedOrigin, snippet: string, round: MaskedCorpus, view: MaskedCorpus): LocateResult {
    if (origin.documentId !== null && !origin.inFixture) {
        const outside = round.get(origin.documentId);
        return locateSnippet(outside === undefined ? new Map() : new Map([[origin.documentId, outside]]), snippet);
    }
    return locateSnippet(view, snippet);
}

/**
 * Turns one recorded response into citation candidates for the scorer.
 * `derivedFrom` comes from the question set, read by the runner — the raw
 * fixture does not carry it, and this function does no I/O.
 */
export function parseResponse(raw: GoogleRawFixture, round: MaskedCorpus, derivedFrom: readonly string[]): ParseResult {
    const view = viewOf(round, derivedFrom);
    const chunks = raw.groundingMetadata?.groundingChunks ?? [];
    const supports = raw.groundingMetadata?.groundingSupports ?? [];

    const candidates: CitationCandidate[] = [];
    let snappedStarts = 0;
    let snappedEnds = 0;
    const length: { segment: number; lengthDelta: number }[] = [];
    const position: number[] = [];
    const missingPart: number[] = [];
    const missingField: { segment: number; field: 'endIndex' | 'segment.text' }[] = [];

    supports.forEach((support, i) => {
        const segment = support.segment;
        const partIndex = segment?.partIndex ?? 0;
        const startByte = segment?.startIndex ?? 0;

        const part = raw.parts[partIndex];
        if (part === undefined) {
            missingPart.push(i);
            return;
        }
        if (segment?.endIndex === undefined) {
            missingField.push({ segment: i, field: 'endIndex' });
            return;
        }
        if (segment.text === undefined) {
            missingField.push({ segment: i, field: 'segment.text' });
            return;
        }
        const endByte = segment.endIndex;

        // (1) the byte length of the marked text is what the offsets say.
        const expectedBytes = endByte - startByte;
        const actualBytes = utf8ByteLength(segment.text);
        if (expectedBytes !== actualBytes) length.push({ segment: i, lengthDelta: expectedBytes - actualBytes });

        let start;
        let end;
        try {
            start = byteOffsetToCodePoint(part.text, startByte, 'start');
            end = byteOffsetToCodePoint(part.text, endByte, 'end');
        } catch (error) {
            // An offset outside the Part cannot be placed anywhere: a position
            // failure, recorded like the others, and no candidate.
            if (error instanceof RangeError) {
                position.push(i);
                return;
            }
            throw error;
        }
        if (start.snapped) snappedStarts++;
        if (end.snapped) snappedEnds++;

        // (2) the converted span selects the text the emitter says it marked.
        if (sliceByCodePoints(part.text, start.index, end.index) !== segment.text) position.push(i);

        const indices = support.groundingChunkIndices ?? [];
        const sources: CitationSource[] = [];
        for (const index of indices) {
            const chunk = chunks[index];
            const snippet = chunk?.retrievedContext?.text;
            if (snippet === undefined) continue; // discarded: no text, no source
            const origin = resolveOrigin(hintOf(chunk), round, view);
            sources.push({ located: locateFor(origin, snippet, round, view), origin });
        }

        candidates.push({
            partIndex,
            textSpan: { start: start.index, end: end.index },
            rawChunkCount: indices.length,
            sources,
        });
    });

    return { candidates, snappedStarts, snappedEnds, violations: { length, position, missingPart, missingField } };
}
