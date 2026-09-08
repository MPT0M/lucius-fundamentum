import { describe, it, expect } from 'vitest';
import { byteOffsetToCodePoint, utf8ByteLength } from './utf8.js';

// The worked example of the plan, measured by hand before it was written:
//   code point | char | bytes
//            2 |  a   | 2
//            3 |  ç   | 3–4
//            4 |  ã   | 5–6
//            5 |  o   | 7
// Both APIs count from zero. Byte 6 is not a boundary of anything: it falls
// inside the `ã`.
const SAMPLE = 'A ação é válida';

describe('utf8ByteLength — the size the emitter measured against', () => {
    it('counts one byte per ASCII character and more per accented one', () => {
        expect(utf8ByteLength('A ')).toBe(2);
        expect(utf8ByteLength('ç')).toBe(2);
        // 15 code points, four of them accented (2 bytes each): 19 bytes. The
        // platform encoder is the independent oracle — a hand count got this
        // wrong once (18) while the test was being written.
        expect(utf8ByteLength(SAMPLE)).toBe(19);
        expect(utf8ByteLength(SAMPLE)).toBe(new TextEncoder().encode(SAMPLE).length);
    });

    it('the three-byte range starts at U+0800, not at U+1000 — measured against the platform encoder', () => {
        // U+0915 (Devanagari ka) is the kind of character a wrong threshold
        // would miscount: above 0x800 and below 0x1000. Japanese kanji sit
        // above 0x1000 and would pass either way, so they cannot catch this.
        const ka = String.fromCodePoint(0x0915);
        const tokyo = String.fromCodePoint(0x6771, 0x4eac, 0x306f, 0x65e5, 0x672c); // 東京は日本
        for (const text of [ka, tokyo, 'Ω' + ka + 'x']) {
            expect(utf8ByteLength(text), text).toBe(new TextEncoder().encode(text).length);
        }
        expect(utf8ByteLength(ka)).toBe(3);
    });

    it('a surrogate pair is one code point and four bytes', () => {
        const script = String.fromCodePoint(0x1d4b3); // 𝒳
        expect(Array.from(script)).toHaveLength(1);
        expect(utf8ByteLength(script)).toBe(4);
    });

    it('the empty string is zero bytes', () => {
        expect(utf8ByteLength('')).toBe(0);
    });

    it('a lone surrogate counts as the three bytes the encoder would emit', () => {
        // Not valid Unicode, but reachable from JSON (`"\ud83d"` on its own).
        // The encoder replaces it with U+FFFD, three bytes; so does the count.
        const lone = '\ud83d';
        expect(utf8ByteLength(lone)).toBe(3);
        expect(utf8ByteLength(lone)).toBe(new TextEncoder().encode(lone).length);
    });
});

describe('byteOffsetToCodePoint — a boundary byte lands on a boundary', () => {
    it('byte 5 is code point 4 and byte 7 is code point 5, for either edge', () => {
        expect(byteOffsetToCodePoint(SAMPLE, 5, 'start')).toEqual({ index: 4, snapped: false });
        expect(byteOffsetToCodePoint(SAMPLE, 5, 'end')).toEqual({ index: 4, snapped: false });
        expect(byteOffsetToCodePoint(SAMPLE, 7, 'start')).toEqual({ index: 5, snapped: false });
        expect(byteOffsetToCodePoint(SAMPLE, 7, 'end')).toEqual({ index: 5, snapped: false });
    });

    it('byte 0 is code point 0 and the byte length is the position after the last code point, for either edge', () => {
        const last = Array.from(SAMPLE).length;
        expect(byteOffsetToCodePoint(SAMPLE, 0, 'start')).toEqual({ index: 0, snapped: false });
        expect(byteOffsetToCodePoint(SAMPLE, 0, 'end')).toEqual({ index: 0, snapped: false });
        expect(byteOffsetToCodePoint(SAMPLE, 19, 'start')).toEqual({ index: last, snapped: false });
        expect(byteOffsetToCodePoint(SAMPLE, 19, 'end')).toEqual({ index: last, snapped: false });
    });

    it('on the empty string only offset 0 exists', () => {
        expect(byteOffsetToCodePoint('', 0, 'start')).toEqual({ index: 0, snapped: false });
        expect(byteOffsetToCodePoint('', 0, 'end')).toEqual({ index: 0, snapped: false });
    });
});

describe('byteOffsetToCodePoint — a byte inside a character snaps, and the direction depends on the edge', () => {
    it('a start inside "ã" (byte 6) snaps BACK to the ã (code point 4) and says so', () => {
        expect(byteOffsetToCodePoint(SAMPLE, 6, 'start')).toEqual({ index: 4, snapped: true });
    });

    it('an end inside "ã" (byte 6) snaps FORWARD past the ã (code point 5) and says so', () => {
        // Snapping an exclusive end back would drop the very character the
        // citation was reaching for. The mutation "end snaps like start" is
        // caught here and only here.
        expect(byteOffsetToCodePoint(SAMPLE, 6, 'end')).toEqual({ index: 5, snapped: true });
    });

    it('every interior byte of a four-byte character snaps to the same two boundaries', () => {
        const text = 'x' + String.fromCodePoint(0x1d4b3) + 'y'; // bytes: x=0, 𝒳=1..4, y=5
        for (const b of [2, 3, 4]) {
            expect(byteOffsetToCodePoint(text, b, 'start')).toEqual({ index: 1, snapped: true });
            expect(byteOffsetToCodePoint(text, b, 'end')).toEqual({ index: 2, snapped: true });
        }
        expect(byteOffsetToCodePoint(text, 1, 'start')).toEqual({ index: 1, snapped: false });
        expect(byteOffsetToCodePoint(text, 5, 'end')).toEqual({ index: 2, snapped: false });
    });

    it('the slice the converted span selects is the text the emitter meant', () => {
        // Bytes [2, 8) cover "ação" (a=2, ç=3-4, ã=5-6, o=7); converting both
        // ends and slicing by code points must give exactly that word, with no
        // accent lost or gained.
        const start = byteOffsetToCodePoint(SAMPLE, 2, 'start').index;
        const end = byteOffsetToCodePoint(SAMPLE, 8, 'end').index;
        expect(Array.from(SAMPLE).slice(start, end).join('')).toBe('ação');
    });
});

describe('byteOffsetToCodePoint — an offset outside the text is an emitter defect, not a clamp', () => {
    it('an offset past the end throws a RangeError that names the offset and the length', () => {
        expect(() => byteOffsetToCodePoint(SAMPLE, 20, 'start')).toThrow(RangeError);
        expect(() => byteOffsetToCodePoint(SAMPLE, 20, 'end')).toThrow(/20.*19-byte/);
    });

    it('a negative or fractional offset is a RangeError naming the value', () => {
        expect(() => byteOffsetToCodePoint(SAMPLE, -1, 'start')).toThrow(RangeError);
        expect(() => byteOffsetToCodePoint(SAMPLE, -1, 'start')).toThrow(/-1/);
        expect(() => byteOffsetToCodePoint(SAMPLE, 2.5, 'start')).toThrow(RangeError);
        expect(() => byteOffsetToCodePoint(SAMPLE, 2.5, 'start')).toThrow(/2\.5/);
    });
});
