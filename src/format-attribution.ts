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
export interface FormattedAttribution<T extends CarriedSpan = CarriedSpan> {
    readonly text: string;
    readonly spans: readonly AttributionSpan[];
    readonly sources: readonly SearchResult[];
    /**
     * `opts.carry`, in the coordinates of `text`: the same entries, in the same
     * order, with only `start` and `end` replaced. Empty when nothing was
     * asked for.
     */
    readonly carried: readonly T[];
}

/**
 * A stretch of the ANSWER — not of a source document — that the caller needs
 * moved through the markers along with the spans: style ranges, syntax
 * removed before the text was marked, anything positioned on it beforehand.
 *
 * **A whole line is the one thing not to carry.** A marker written at the
 * very end of a line lands exactly at the stretch's `end`, which does not
 * count it, so the line comes back without the marker that belongs to it. A
 * consumer that needs lines matches them by line number, which no insertion
 * moves, because no marker holds a newline.
 *
 * `attach` matters only when `start === end`, and it is required there. A
 * point has no inside for a marker to fall into, so something has to say which
 * side of an insertion at that point it lands on: `'left'` keeps it before the
 * marker, `'right'` puts it after. The name describes where the POINT goes,
 * not where the marker goes — the two are inverse, and reading one as the
 * other puts a delimiter on the wrong side of `[1]` without any symptom.
 */
export interface CarriedSpan extends Span {
    readonly attach?: 'left' | 'right';
}

export interface FormatOptions<T extends CarriedSpan = CarriedSpan> {
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

    /**
     * Stretches of the answer to move through the markers, returned as
     * `carried`. The arithmetic of the move lives here and nowhere else, so a
     * caller that styles or annotates the answer never recounts marker widths.
     *
     * **The two ends of a stretch move by different rules.** An insertion at
     * P sits BEFORE the code point at P in the marked text. So `start` counts
     * insertions at `offset <= start` — a stretch that begins at P begins
     * after the marker — and `end`, being exclusive, counts `offset < end` —
     * a stretch that ends at P ends before it. A stretch that crosses P comes
     * back containing the marker; one that only touches it, on either side,
     * never swallows it.
     *
     * **A point (`start === end`) uses its `attach` at both ends.** The two-end
     * rule would invert it — `start` would pass the marker and `end` would
     * not, leaving `end < start`. `'left'` counts `<` at both ends, `'right'`
     * counts `<=`. A point without `attach` is refused, since either answer
     * would be a guess the caller cannot see.
     *
     * **Entries that land on the same position keep their order.** `carried`
     * is `carry` mapped, never re-sorted, and a caller may depend on that —
     * two removed delimiters at one point are restored in the order they had.
     *
     * This is NOT the rule `spans` are moved by. Those use `<` at both ends,
     * and that is correct for them: see `shiftSpan`.
     */
    readonly carry?: readonly T[];
}

/** One marker to be written into the text: what, and where. */
interface Insertion {
    readonly offset: number;
    readonly text: string;
    /** Position in `sources`. The number shown is this plus one. */
    readonly sourceIndex: number;
}

export function formatAttribution<T extends CarriedSpan = CarriedSpan>(
    attribution: Attribution,
    opts: FormatOptions<T> = {},
): FormattedAttribution<T> {
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

    // The same count with `<=`, for the one place `<` is wrong: the start of a
    // carried stretch, and a point attached to the right.
    const shiftPast = (position: number): number => {
        let total = position;
        for (const insertion of insertions) {
            if (insertion.offset <= position) total += countCodePoints(insertion.text);
        }
        return total;
    };

    const carried = (opts.carry ?? []).map((entry) => carryThrough(entry, shift, shiftPast));

    const text = writeMarkers(attribution.text, insertions);

    return { text, spans, sources: attribution.sources, carried };
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

/**
 * `<` at BOTH ends, which a carried stretch must not use and a clause may.
 *
 * The start of a clause can never coincide with an insertion: markers go at
 * `anchorOffset`, and `recedeAnchor` places that strictly after the clause's
 * start — it walks back from the end and returns the end itself if it reaches
 * the start. So the rule that would be wrong at a start is never exercised
 * here. Unifying this with `carryThrough` would look like a cleanup and would
 * change nothing for spans; the reverse, giving carried stretches this rule,
 * is the defect `carryThrough` exists to avoid.
 */
function shiftSpan(span: Span, shift: (p: number) => number): Span {
    return { start: shift(span.start), end: shift(span.end) };
}

/** One entry of `carry` through the markers, by the rule `FormatOptions.carry` states. */
function carryThrough<T extends CarriedSpan>(
    entry: T,
    shift: (p: number) => number,
    shiftPast: (p: number) => number,
): T {
    if (entry.end < entry.start) {
        throw new RangeError(`carry: entry ends before it starts (start ${entry.start}, end ${entry.end})`);
    }
    if (entry.end > entry.start) {
        return { ...entry, start: shiftPast(entry.start), end: shift(entry.end) };
    }
    if (entry.attach === undefined) {
        throw new RangeError(
            `carry: a point at ${entry.start} needs \`attach\` — nothing else says which side of a marker it lands on`,
        );
    }
    const at = entry.attach === 'left' ? shift(entry.start) : shiftPast(entry.start);
    return { ...entry, start: at, end: at };
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


