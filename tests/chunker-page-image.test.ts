/**
 * `SourceDoc.page`: the rasterized page the caller supplies when a page's text
 * could not be extracted.
 *
 * What these tests hold is the REFUSAL, not the field. A field is a type and
 * the compiler already guards it; the refusal is a runtime rule, and it is the
 * rule that keeps a document out of a ranking that has no way to score it.
 */
import { describe, expect, it } from 'vitest';
import { chunk, DEFAULT_CHUNK_OPTIONS, isImageOnly, type SourceDoc } from '../src/chunker.js';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const page = { data: PIXEL, mimeType: 'image/png' } as const;

describe('a page image and text together are refused', () => {
    it('a document carrying both is refused, and the message says how much text it found', () => {
        const doc: SourceDoc = { id: 'p7', text: 'Resistores em serie somam.', page, pageNumber: 7 };
        expect(() => chunk(doc, DEFAULT_CHUNK_OPTIONS)).toThrow(/carries both a page image and text/u);
        expect(() => chunk(doc, DEFAULT_CHUNK_OPTIONS)).toThrow(/26 code points/u);
        expect(() => chunk(doc, DEFAULT_CHUNK_OPTIONS)).toThrow(/p7/u);
    });

    it('whitespace is not text, so a page image with a blank text field passes', () => {
        // The caller that has no text has to put SOMETHING in `text`, which is
        // required. Blank must not trip the guard, or the supported case would
        // be unreachable.
        for (const blank of ['', '   ', '\n\n', '\t']) {
            const doc: SourceDoc = { id: 'p8', text: blank, page, pageNumber: 8 };
            expect(() => chunk(doc, DEFAULT_CHUNK_OPTIONS)).not.toThrow();
        }
    });

    it('text with no page image is untouched by the guard', () => {
        const doc: SourceDoc = { id: 'p9', text: 'Uma corrente eletrica atravessa o fio.', pageNumber: 9 };
        expect(chunk(doc, DEFAULT_CHUNK_OPTIONS).length).toBeGreaterThan(0);
    });

    it('the guard measures code points, not UTF-16 units', () => {
        // Four astral characters are 8 UTF-16 units and 4 code points. The
        // count in the message is what a reader compares against their input,
        // so it has to be the same unit the rest of the package publishes.
        const doc: SourceDoc = { id: 'p10', text: '𝄞𝄞𝄞𝄞', page };
        expect(() => chunk(doc, DEFAULT_CHUNK_OPTIONS)).toThrow(/4 code points/u);
    });
});

describe('isImageOnly', () => {
    it('is true exactly when the document carries a page image', () => {
        expect(isImageOnly({ id: 'a', text: '', page })).toBe(true);
        expect(isImageOnly({ id: 'b', text: 'texto' })).toBe(false);
        expect(isImageOnly({ id: 'c', text: '', pageNumber: 3 })).toBe(false);
    });
});
