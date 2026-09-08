/**
 * Byte offsets from a hosted response become code point offsets on the text
 * they were measured against.
 *
 * Google's `groundingSupports[].segment.startIndex/endIndex` are UTF-8 byte
 * offsets into the text of one `Part` of the generated response. Everything in
 * this package is code points. The conversion is a walk over the code points
 * of the Part's text, adding up their UTF-8 lengths until the byte offset is
 * reached — with one rule for the case the walk lands INSIDE a multi-byte
 * character. That case is not hypothetical: accented text shifts every
 * byte offset by one per accent, so any emitter that measures in bytes and
 * splits between them will produce it.
 *
 * The rule is asymmetric because an interval has two ends. A `start` byte
 * inside a character snaps BACK to that character's first code point (floor):
 * the character is kept. An `end` byte (exclusive) inside a character snaps
 * FORWARD past it (ceil): snapping it back would drop the character the
 * citation was reaching for. Each snap is reported, so the harness can count
 * how often the emitter produced an offset that was not a character boundary
 * — counting is what stops the correction from hiding the defect it corrects.
 *
 * This module lives in the harness, not in the package: the package never
 * consumes byte offsets. It has no dependency on Node.
 */

export type Edge = 'start' | 'end';

export interface CodePointOffset {
    /** Code point index into the same text, 0-based; exclusive when `edge` is `'end'`. */
    readonly index: number;
    /** True when the byte offset fell inside a multi-byte character and was moved to a boundary. */
    readonly snapped: boolean;
}

/** UTF-8 length of one code point. A lone surrogate counts as its 3-byte replacement. */
function utf8LengthOf(codePoint: number): number {
    if (codePoint < 0x80) return 1;
    if (codePoint < 0x800) return 2;
    if (codePoint < 0x10000) return 3;
    return 4;
}

/** Number of bytes `text` occupies in UTF-8. */
export function utf8ByteLength(text: string): number {
    let bytes = 0;
    for (const ch of text) bytes += utf8LengthOf(ch.codePointAt(0)!);
    return bytes;
}

/**
 * Converts a UTF-8 byte offset into `partText` to a code point offset.
 *
 * `byteOffset` must lie in `[0, utf8ByteLength(partText)]`; anything else is a
 * `RangeError` that names the offset and the length, because an offset past
 * the end is an emitter defect the harness has to report, never silently clamp.
 * An offset exactly at the end is the position after the last code point, for
 * either edge, and is not a snap.
 */
export function byteOffsetToCodePoint(partText: string, byteOffset: number, edge: Edge): CodePointOffset {
    if (!Number.isInteger(byteOffset) || byteOffset < 0) {
        throw new RangeError(`byte offset must be a non-negative integer, got ${byteOffset}`);
    }
    let bytes = 0;
    let index = 0;
    for (const ch of partText) {
        const width = utf8LengthOf(ch.codePointAt(0)!);
        if (byteOffset === bytes) return { index, snapped: false };
        if (byteOffset < bytes + width) {
            // Inside this code point: floor for a start, ceil for an end.
            return { index: edge === 'start' ? index : index + 1, snapped: true };
        }
        bytes += width;
        index++;
    }
    if (byteOffset === bytes) return { index, snapped: false };
    throw new RangeError(`byte offset ${byteOffset} is past the end of a ${bytes}-byte text`);
}
