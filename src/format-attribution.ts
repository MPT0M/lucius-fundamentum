/**
 * Turns an attribution into text a reader sees, and hands back the positions it
 * just moved.
 *
 * The engine never touches the answer. This does — it inserts markers — and
 * that is exactly why it must return the spans REINDEXED. Inserting a marker
 * pushes every later offset, and a caller that formatted and then used the
 * original spans would get drift: the same class of defect that makes a chat
 * client turn its citation chips off when a message carries a visual block.
 * Leaving that mine in a public contract is not an option.
 *
 * **The offsets that come back are code points, and that is where a consumer
 * reintroduces the defect.** `text[span.start]` and `substring` index UTF-16
 * units, and a DOM range takes units too, so an emoji or a rare CJK character
 * earlier in the answer puts the highlight in the wrong place. The cheap test
 * for whether naive indexing is safe on a given string is
 * `text.length === countCodePoints(text)`: equal means pure BMP, where units
 * and code points coincide. Unequal means converting, and `sliceByCodePoints`
 * is exported for it.
 */

import type { Span } from './types.js';
import { countCodePoints } from './unicode.js';
import type { SearchResult } from './index-build.js';
import type { Attribution, AttributionSpan } from './attribute.js';

/**
 * What the reader's layer receives.
 *
 * `sources` travels with it, and that is a deliberate addition to the shape the
 * spec drew. The marker's number is a POSITION IN `sources` — the only set both
 * delivery modes produce identically — so a consumer holding the formatted text
 * alone would receive `[4]` with nothing to resolve the 4 against. The pairing
 * that leaves nothing at all is `bibliography: 'none'`; `markerStyle: 'none'`
 * still emits the footer, and that pair is the voice case.
 *
 * `rungs` does not travel: it is what the ruler reads, not what the page shows.
 */
export interface FormattedAttribution {
    readonly text: string;
    readonly spans: readonly AttributionSpan[];
    readonly sources: readonly SearchResult[];
}

export interface FormatOptions {
    /**
     * `'interactive'` emits `[1](#cite-0), [2](#cite-1)`: independent brackets,
     * the number legible INSIDE each one, and a self-standing anchor, so a UI
     * that does not intercept `#cite-` still shows something a reader can read
     * and click, and the separation of spans and popovers survives in the data.
     *
     * `'bracket'` emits `[1], [2]` for text that leaves the page — pasted into
     * a message, a document, an email.
     *
     * `'none'` emits nothing. Nothing is inserted, so nothing shifts and the
     * spans come back untouched: it is the control the other two are measured
     * against, and it is the mode a screen reader wants, which is why the
     * bibliography axis is separate.
     */
    readonly markerStyle?: 'interactive' | 'bracket' | 'none';
    readonly bibliography?: 'footer' | 'none';
}

/** One marker to be written into the text: what, and where. */
interface Insertion {
    readonly offset: number;
    readonly text: string;
    /** Position in `sources`. The number shown is this plus one. */
    readonly sourceIndex: number;
}

export function formatAttribution(
    attribution: Attribution,
    opts: FormatOptions = {},
): FormattedAttribution {
    const markerStyle = opts.markerStyle ?? 'interactive';
    const bibliography = opts.bibliography ?? 'none';

    // 1. NUMBER, before anything is built. The width of a marker depends on the
    //    number — `[9]` is three characters and `[10]` is four — so building
    //    insertions first would mean reindexing against widths that are still
    //    going to change.
    const indexByChunk = new Map<string, number>();
    attribution.sources.forEach((result, index) => {
        if (!indexByChunk.has(result.chunk.id)) indexByChunk.set(result.chunk.id, index);
    });

    // 2. DEDUPLICATE. One marker per (anchorOffset, chunkId): two spans of the
    //    SAME passage at the same point are one citation to the reader, and
    //    showing the number twice is the pair of numbers stuck to one idea that
    //    the density rules exist to avoid. Two spans of DIFFERENT passages at
    //    the same point stay two — hiding that would collapse two sources into
    //    one popover and kill the granularity.
    const insertions: Insertion[] = [];
    if (markerStyle !== 'none') {
        // Keyed by structure, never by a joined string: a document id may
        // contain whatever a caller puts in it, and a separator that can
        // appear inside the key is a collision waiting for the one corpus
        // that uses it.
        const seen = new Map<number, Set<string>>();
        for (const span of [...attribution.spans].sort(byAnchorThenChunk)) {
            const atOffset = seen.get(span.anchorOffset) ?? new Set<string>();
            if (atOffset.has(span.chunkId)) continue;
            atOffset.add(span.chunkId);
            seen.set(span.anchorOffset, atOffset);
            const sourceIndex = indexByChunk.get(span.chunkId);
            if (sourceIndex === undefined) continue;
            insertions.push({
                offset: span.anchorOffset,
                text: marker(markerStyle, sourceIndex),
                sourceIndex,
            });
        }
    }

    // 3. REINDEX, by summing the widths of the INSERTIONS before each offset —
    //    never by walking spans and adding a marker width per span. Two spans
    //    that share one marker would shift everything after them TWICE, by one
    //    width too much, which is the drift this function returns spans to
    //    prevent.
    const shift = (position: number): number => {
        let total = position;
        for (const insertion of insertions) {
            if (insertion.offset < position) total += countCodePoints(insertion.text);
        }
        return total;
    };

    const spans = attribution.spans.map((span) => ({
        ...span,
        textSpan: shiftSpan(span.textSpan, shift),
        anchorOffset: shift(span.anchorOffset),
        // NOT shifted: `sourceSpan` measures the SOURCE DOCUMENT, where nothing
        // was inserted. Reindexing it too is the easiest way to ruin the field
        // the popover opens on.
        sourceSpan: span.sourceSpan,
    }));

    let text = writeMarkers(attribution.text, insertions);
    if (bibliography === 'footer') text += footerFor(attribution, insertions);

    return { text, spans, sources: attribution.sources };
}

function byAnchorThenChunk(a: AttributionSpan, b: AttributionSpan): number {
    return a.anchorOffset - b.anchorOffset || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0);
}

function marker(style: 'interactive' | 'bracket', sourceIndex: number): string {
    const number = sourceIndex + 1;
    return style === 'bracket' ? `[${number}]` : `[${number}](#cite-${sourceIndex})`;
}

function shiftSpan(span: Span, shift: (p: number) => number): Span {
    return { start: shift(span.start), end: shift(span.end) };
}

/** Writes the markers in, working in code points because every offset is one. */
function writeMarkers(text: string, insertions: readonly Insertion[]): string {
    if (insertions.length === 0) return text;
    const points = Array.from(text);
    const ordered = [...insertions].sort((a, b) => a.offset - b.offset);
    let out = '';
    let cursor = 0;
    for (const insertion of ordered) {
        out += points.slice(cursor, insertion.offset).join('') + insertion.text;
        cursor = insertion.offset;
    }
    return out + points.slice(cursor).join('');
}

/**
 * The bibliography lists what was CITED, in number order — never `sources`.
 *
 * `sources` is the complete inventory and comes back filled in every mode,
 * uncited results included. A footer compiled from it would publish, with a
 * `topK` of ten and three passages cited, ten entries and seven with no
 * counterpart in the text. A bibliography asserting provenance the answer does
 * not have is the inverse of this package's argument.
 *
 * It carries identifiers rather than prose: a reader's layer knows how to show
 * a document better than this function does, and inventing a title here would
 * be inventing.
 */
function footerFor(attribution: Attribution, insertions: readonly Insertion[]): string {
    const cited = new Map<number, string>();
    for (const insertion of insertions) {
        const source = attribution.sources[insertion.sourceIndex];
        if (source !== undefined) cited.set(insertion.sourceIndex, source.chunk.documentId);
    }
    // With `markerStyle: 'none'` there are no insertions, and the footer is the
    // only provenance the reader gets — so it is built from the spans instead.
    if (insertions.length === 0) {
        for (const span of attribution.spans) {
            const index = attribution.sources.findIndex((r) => r.chunk.id === span.chunkId);
            if (index >= 0) cited.set(index, span.documentId);
        }
    }
    if (cited.size === 0) return '';
    const lines = [...cited.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, documentId]) => `[${index + 1}] ${documentId}#${attribution.sources[index]!.chunk.id}`);
    return `\n\n${lines.join('\n')}`;
}

