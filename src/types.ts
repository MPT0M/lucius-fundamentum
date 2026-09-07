/**
 * Canonical types shared by every layer.
 *
 * One rule governs all positions in this package: they are Unicode code point
 * offsets into the RAW text, 0-based, end-exclusive. Never bytes — a hosted
 * file-search API reports bytes, and every accented character shifts its
 * citations by one. Never UTF-16 units — an emoji is two of those and one
 * character. And never into normalized text: normalization changes length, so
 * a position measured against it would need a translation table back to the
 * source, which is the whole class of defect this package exists to remove.
 */

/**
 * A half-open range of code points, `[start, end)`, into the raw text it was
 * measured against.
 *
 * Both fields are always present and always numbers. There is no optional
 * position and no default that means "absent": a citation opening at offset
 * zero is the most common citation there is, and a format that drops zero as a
 * default value sends it to the wrong place in silence.
 */
export interface Span {
    readonly start: number;
    readonly end: number;
}
