/**
 * Where a sentence begins and ends, measured once for the whole package.
 *
 * Two layers need this boundary and they must agree: the chunker cuts on it,
 * and the attributor checks one clause of an answer against one sentence of a
 * passage. Two implementations of "where does a sentence end" diverge, and in
 * Portuguese they diverge first on the cases this library exists for — `art. 5º`
 * keeps its period, `$x = 1.$` keeps its dot, a URL keeps its dots — because
 * every one of those depends on masking the protected regions BEFORE the
 * segmenter sees the text. A second implementation written for the attributor
 * would not have that step, and the disagreement would surface as a citation
 * pointing at half a sentence.
 */

import type { Span } from './types.js';
import { countCodePoints } from './unicode.js';
import { maskProtectedRegions } from './mask.js';
import type { AbbreviationList } from './abbreviations.js';

/**
 * Anything with the shape of `Intl.Segmenter`: given a string, yields the
 * segments with their UTF-16 start index. Injectable so the library does not
 * hard-wire a runtime API — `Intl.Segmenter` is the default where it exists,
 * and a caller on a runtime without it supplies its own.
 */
export interface Segmenter {
    segment(text: string): Iterable<{ readonly index: number; readonly segment: string }>;
}

/**
 * A sentence as a code point span into the text it was measured against.
 *
 * There is deliberately no `length`. It existed, nobody read it after the
 * budgets started measuring intervals, and a second way to express the size of
 * the same thing is what let the budget and the emitted chunk disagree in the
 * first place.
 */
export type Sentence = Span;

export function defaultSegmenter(): Segmenter {
    return new Intl.Segmenter('pt-BR', { granularity: 'sentence' });
}

/**
 * Sentence spans of `text`, in code points, computed on the MASKED text so no
 * boundary can land inside a formula, code, URL, on the period of a numbered
 * list item, or after an abbreviation.
 * Because the mask preserves length, the spans are valid on the original.
 *
 * The spans are relative to `text`. A caller holding a fragment of a larger
 * document — a chunk, say — adds the fragment's own start to get document
 * coordinates, and accepts what `tokenizer.ts` documents about fragments: a
 * protected region crossing the fragment's edge masks differently there than it
 * does in the whole document, because half of a fenced block has no fence.
 */
export function sentencesOf(
    text: string,
    segmenter: Segmenter,
    abbreviations?: AbbreviationList,
): Sentence[] {
    const masked = maskProtectedRegions(text, abbreviations ? { abbreviations } : {}).text;
    const out: Sentence[] = [];
    let utf16Cursor = 0;
    let cpCursor = 0;
    for (const { index, segment } of segmenter.segment(masked)) {
        // Segments come in order and are contiguous; advance the code point
        // cursor by the code points between the last segment and this one
        // (normally zero) rather than recounting from the start each time.
        cpCursor += countCodePoints(masked.slice(utf16Cursor, index));
        const trimmed = trimmedSpan(segment, cpCursor);
        if (trimmed) out.push(trimmed);
        utf16Cursor = index + segment.length;
        cpCursor += countCodePoints(segment);
    }
    return out;
}

/**
 * The segmenter hands back each sentence WITH the whitespace that follows it
 * — the space after the period, the newline after the paragraph. The span is
 * tightened to the first and last non-space code point, because a citation
 * that ends in a trailing space is sloppy.
 *
 * Trimming bounds the SENTENCE, not whatever the caller builds out of it. The
 * chunker's chunk is the continuous interval from the first sentence's start to
 * the last one's end, so it does carry the whitespace between them, and the
 * budget measures that interval — see `chunk`. An earlier version of this
 * comment claimed the trailing space "would count against the chunk budget"; it
 * did not, and that gap between what was counted and what was emitted is the
 * defect the budgets now close.
 *
 * The mask character is not whitespace, so a sentence that is nothing but a
 * formula keeps its full extent.
 *
 * Returns `null` for a segment that is whitespace only.
 */
export function trimmedSpan(segment: string, start: number): Sentence | null {
    const points = Array.from(segment);
    let a = 0;
    let b = points.length;
    while (a < b && /\s/u.test(points[a]!)) a++;
    while (b > a && /\s/u.test(points[b - 1]!)) b--;
    if (a === b) return null;
    return { start: start + a, end: start + b };
}

/**
 * Where a citation marker belongs at the end of a clause: before the trailing
 * punctuation, not after it.
 *
 * Walks back from `end` while the preceding code point is punctuation that
 * closes the clause, stopping at `start`. `'...quinze dias corridos.'` anchors
 * before the period, so the marker reads `...corridos [1].` rather than
 * `...corridos.[1]`.
 *
 * **The predicate is three Unicode properties, and the fourth was refused on
 * purpose.** Sentence terminals and quotation marks recede; closing
 * punctuation (`\p{Pe}`) does not. The test is detachability: delete
 * `(BRASIL, 1988)` and the clause still stands, so the parenthetical is an
 * aside and a marker placed before it would attribute the source to the aside;
 * delete the quoted material and the clause collapses, so the quote is inside
 * the assertion the source supports.
 *
 * Opening marks (`«`, `「`) match `\p{Quotation_Mark}` too. They are harmless
 * in a loop that only ever walks backwards from the end, and the check is not
 * narrowed to closing marks because doing so would need a hand-kept list where
 * a property already answers.
 *
 * `…` matches none of the three and is the only residue in the table, so it is
 * named directly.
 *
 * **A clause that is punctuation all the way down keeps its anchor at `end`.**
 * The walk floors at `start`, and reaching the floor means there is no text to
 * sit in front of — so receding there would put the marker before everything
 * it cites, which is the one position that has no reading. Falling back to
 * `end` is the same output the package produced before the recede existed.
 */
export function recedeAnchor(points: readonly string[], start: number, end: number): number {
    const RECEDES = /[\p{Sentence_Terminal}\p{Quotation_Mark}…]/u;
    let at = end;
    while (at > start && RECEDES.test(points[at - 1]!)) at--;
    return at === start ? end : at;
}

/**
 * Where each paragraph of a text ends, in code points.
 *
 * A paragraph boundary is a blank line: a newline, optional horizontal
 * whitespace, another newline. `\n\n` written literally is wrong and fails in
 * silence — a CRLF document never matches it, zero boundaries becomes one
 * marker for the whole answer, and nothing throws.
 *
 * **It masks internally, and takes raw text for that reason.** The earlier
 * design took already-masked text, which left a precondition no public door
 * could satisfy: `sentencesOf` masks and returns spans only, discarding the
 * masked string, so nothing in the attribution path holds one. Taking raw
 * text mirrors `sentencesOf` and removes the trap instead of documenting it.
 *
 * The mask is what keeps a blank line inside a fenced code block from
 * fabricating a boundary: `paint` overwrites every code point of a protected
 * region, newlines included, and the length is preserved, so the offsets this
 * returns are valid on the original text.
 *
 * The cost is a second masking pass per attribution: this one, plus the one
 * inside `sentencesOf`. They are not the same mask — that one is given the
 * abbreviation list and this one is not — but they agree on every newline,
 * which is all this function reads, and both preserve length. The
 * alternative, having `sentencesOf` return its masked string, changes an
 * existing contract to save a pass nobody has measured, so it was refused.
 *
 * The last paragraph ends at the end of the text, whether or not the text
 * closes with a blank line.
 */
export function paragraphEndsOf(text: string): number[] {
    const masked = maskProtectedRegions(text).text;
    const points = Array.from(masked);
    const BLANK_LINE = /\r?\n[^\S\r\n]*\r?\n/gu;
    const ends: number[] = [];
    for (const match of masked.matchAll(BLANK_LINE)) {
        ends.push(countCodePoints(masked.slice(0, match.index)));
    }
    ends.push(points.length);
    return ends;
}
