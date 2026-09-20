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
 * spec drew. The marker's number is a POSITION IN `sources` — the complete
 * inventory, identical for both doors — so a consumer holding the formatted text
 * alone would receive `[4]` with nothing to resolve the 4 against.
 *
 * **Provenance travels in the data, not in the formatted text, and that is what
 * serves a screen reader.** `markerStyle: 'none'` returns the answer with no
 * marker in it; `sources` and `spans` still say which passage supports which
 * stretch, and the caller composes a source list from its own registry — file
 * name, page, URL, things this package does not know. A caller that ignores
 * `sources` gets text with no provenance at all, which is the cost of the
 * package not compiling that list itself.
 *
 * **In this coordinate space a `textSpan` covers the clause TOGETHER WITH the
 * markers written inside it.** The anchor sits before the trailing
 * punctuation, so an insertion lands in the clause's interior and `end` moves
 * past it. Keeping the marker out was tried and is not merely inelegant, it is
 * arithmetically impossible: the region it would need is discontiguous, and a
 * `Span {start, end}` cannot express a hole. An `end` short of the marker cuts
 * it in half - `'...corridos ['`. A caller that wants the clause without
 * markers uses `markerStyle: 'none'`, where nothing is inserted and nothing
 * shifts.
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
     * A marker is written BEFORE the clause's trailing punctuation, preceded
     * by a space, and a second marker at the same anchor is joined with `, `:
     * `O prazo é de quinze dias [1], [2].` The punctuation closes the clause
     * the citation is inside of, so a marker after it reads as belonging to
     * whatever comes next.
     *
     * The space is a deliberate, uniform choice and not derived from the
     * script. In Japanese, `この規定は十五日です [1]。` carries a space that the
     * writing system does not ask for; it is the same convention everywhere
     * rather than a per-locale rule, and it is written down here so nobody
     * "fixes" it against a Japanese fixture.
     *
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
     * against, and it is the mode a screen reader wants — the provenance it
     * needs is in `sources` and `spans`, not in the text.
     */
    readonly markerStyle?: 'interactive' | 'bracket' | 'none';
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
        // The affix depends on POSITION IN THE GROUP, so the count per offset
        // is kept while the group is built: the first marker at an anchor
        // opens with a space, each later one with `, `.
        const written = new Map<number, number>();
        for (const span of [...attribution.spans].sort(byAnchorThenSource(indexByChunk))) {
            const atOffset = seen.get(span.anchorOffset) ?? new Set<string>();
            if (atOffset.has(span.chunkId)) continue;
            const sourceIndex = indexByChunk.get(span.chunkId);
            if (sourceIndex === undefined) continue;
            atOffset.add(span.chunkId);
            seen.set(span.anchorOffset, atOffset);
            const position = written.get(span.anchorOffset) ?? 0;
            written.set(span.anchorOffset, position + 1);
            insertions.push({
                offset: span.anchorOffset,
                // The affix goes INSIDE `insertion.text`, never written
                // separately: `shift` sums the width of this string, and a
                // separator added outside it would be uncounted, drifting
                // every span after the group by exactly its length.
                text: (position === 0 ? ' ' : ', ') + marker(markerStyle, sourceIndex),
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

    const text = writeMarkers(attribution.text, insertions);

    return { text, spans, sources: attribution.sources };
}

/**
 * Orders the markers of one anchor by the NUMBER the reader will see.
 *
 * Sorting by `chunkId` put the group in identifier order, which is not the
 * order of the numbers written from it — `[3], [1]` is a legal output of that
 * comparator and reads as a mistake. The tie-break is the position in
 * `sources`, which is what the number is. A chunk with no entry in `sources`
 * emits no marker at all, so where it sorts cannot be observed; it is sent to
 * the end rather than to the front so that it never splits a real group.
 */
function byAnchorThenSource(
    indexByChunk: ReadonlyMap<string, number>,
): (a: AttributionSpan, b: AttributionSpan) => number {
    const rank = (span: AttributionSpan): number =>
        indexByChunk.get(span.chunkId) ?? Number.MAX_SAFE_INTEGER;
    return (a, b) => a.anchorOffset - b.anchorOffset || rank(a) - rank(b);
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


