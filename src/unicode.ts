/**
 * Scalar Unicode primitives. Pure functions, no state, no dependencies.
 *
 * JavaScript strings are UTF-16: `'💡'.length` is 2 and `'ç'` can be one code
 * point or two, depending on who wrote the file. Everything downstream — the
 * chunker, the index, the citation — needs one honest unit, and that unit is
 * the code point. These helpers are where the conversion happens, once.
 */

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
