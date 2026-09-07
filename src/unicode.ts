/**
 * Scalar Unicode primitives. Pure functions, no state, no dependencies.
 *
 * JavaScript strings are UTF-16: `'💡'.length` is 2 and `'ç'` can be one code
 * point or two, depending on who wrote the file. Everything downstream — the
 * chunker, the index, the citation — needs one honest unit, and that unit is
 * the code point. These helpers are where the conversion happens, once.
 */

import type { Span } from './types.js';

/**
 * Number of Unicode code points in `text`.
 *
 * Not `text.length`, which counts UTF-16 units and reports 2 for a single
 * emoji or a single mathematical letter like 𝒳.
 */
export function countCodePoints(text: string): number {
    let n = 0;
    for (const _ of text) n++;
    return n;
}

/**
 * Canonical composition (NFC): the same letter written two ways becomes one.
 *
 * `ç` typed on a keyboard is U+00E7. `ç` produced by some OCR and some editors
 * is `c` followed by a combining cedilla, U+0063 U+0327 — two code points that
 * render identically and compare as different. Left alone, the same word
 * becomes two terms in the index, and a query for one never finds the other.
 *
 * NFC and not NFKC on purpose. NFKC also folds compatibility characters:
 * `5º` becomes `5o`, `²` becomes `2`, `…` becomes `...`. That destroys exactly
 * the precision a lexical index exists to keep — "Artigo 5º" and "artigo
 * quinto" are different things to someone reading the law.
 *
 * THIS CHANGES LENGTH. Two code points become one. That is why positions in
 * this package are never measured against normalized text: normalize the key
 * you compare with, keep the span on the raw source. See `tests/unicode.test.ts`
 * for the proof.
 */
export function normalizeUnicode(text: string): string {
    return text.normalize('NFC');
}

/**
 * The substring of `text` between code point offsets `[start, end)`.
 *
 * `String.prototype.slice` works in UTF-16 units and will happily cut an emoji
 * in half, leaving a lone surrogate that renders as � and breaks any equality
 * check downstream. This walks code points, so a boundary can never fall
 * inside a character.
 *
 * Bounds are clamped, not thrown. A caller with a span from an older index, or
 * from a citation that overran the text, gets the honest prefix/suffix instead
 * of an exception in the render path. Negative offsets count from the end, as
 * in `slice`. `end` before `start` yields the empty string.
 */
export function sliceByCodePoints(text: string, start: number, end?: number): string {
    const points = Array.from(text);
    const total = points.length;
    const from = clamp(start < 0 ? total + start : start, 0, total);
    const rawTo = end === undefined ? total : end < 0 ? total + end : end;
    const to = clamp(rawTo, from, total);
    return points.slice(from, to).join('');
}

function clamp(value: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, value));
}

/**
 * Every match of `re` in `text`, as a code point span into `text`.
 *
 * `String.prototype.matchAll` reports `index` in UTF-16 units. Everything in
 * this package positions in code points, so the conversion has to happen at
 * the one place regex results enter — here — and nowhere else. `re` must carry
 * the `g` flag; `matchAll` throws otherwise, which is the right failure.
 */
export function matchSpans(text: string, re: RegExp): Span[] {
    const out: Span[] = [];
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
        const start = countCodePoints(text.slice(0, m.index));
        out.push({ start, end: start + countCodePoints(m[0]) });
    }
    return out;
}
