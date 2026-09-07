import { describe, it, expect } from 'vitest';
import { countCodePoints, normalizeUnicode } from '../src/unicode.js';

// Built from code points so no editor, formatter or line-ending pass can
// silently recompose them. If a tool "fixed" these literals the test would
// still test what it says it tests.
const C_CEDILLA_COMPOSED = 'ç';                 // ç, one code point
const C_CEDILLA_DECOMPOSED = 'ç';              // c + combining cedilla, two
const A_TILDE_DECOMPOSED = 'ã';                // a + combining tilde

describe('countCodePoints — counts characters, not UTF-16 units', () => {
    it('agrees with .length on plain ASCII', () => {
        expect(countCodePoints('Constituicao')).toBe(12);
    });

    it('counts an emoji as one, where .length says two', () => {
        const bulb = '💡';
        expect(bulb.length).toBe(2);
        expect(countCodePoints(bulb)).toBe(1);
    });

    it('counts a mathematical letter as one, where .length says two', () => {
        const scriptX = '𝒳';
        expect(scriptX.length).toBe(2);
        expect(countCodePoints(scriptX)).toBe(1);
    });

    it('counts a decomposed ç as two — it IS two code points', () => {
        expect(countCodePoints(C_CEDILLA_DECOMPOSED)).toBe(2);
        expect(countCodePoints(C_CEDILLA_COMPOSED)).toBe(1);
    });

    it('is zero for the empty string', () => {
        expect(countCodePoints('')).toBe(0);
    });
});

describe('normalizeUnicode — the same letter written two ways becomes one', () => {
    it('folds c + combining cedilla into the composed ç', () => {
        expect(normalizeUnicode(C_CEDILLA_DECOMPOSED)).toBe(C_CEDILLA_COMPOSED);
    });

    it('makes "acao" written both ways compare equal', () => {
        const typed = 'ação';                                    // açã o, composed
        const ocr = 'a' + C_CEDILLA_DECOMPOSED + A_TILDE_DECOMPOSED + 'o'; // decomposed
        expect(typed).not.toBe(ocr);
        expect(normalizeUnicode(typed)).toBe(normalizeUnicode(ocr));
    });

    it('is idempotent', () => {
        const once = normalizeUnicode(C_CEDILLA_DECOMPOSED);
        expect(normalizeUnicode(once)).toBe(once);
    });

    it('is NFC, not NFKC: ordinal and superscript survive', () => {
        // NFKC would turn these into "5o" and "2", erasing the distinction a
        // lexical index exists to keep. NFC leaves them alone.
        expect(normalizeUnicode('5º')).toBe('5º');
        expect(normalizeUnicode('x²')).toBe('x²');
        expect(normalizeUnicode('…')).toBe('…');
    });
});

describe('normalization CHANGES LENGTH — why spans live on the raw text', () => {
    // This is the proof behind the package's central rule. If normalization
    // preserved length, positions could be measured against normalized text
    // for free. It does not, so they cannot: a span measured on the normalized
    // string would need a translation table back to the source — the exact
    // class of defect this library exists to eliminate.
    it('two code points become one for c + cedilla', () => {
        const before = countCodePoints(C_CEDILLA_DECOMPOSED);
        const after = countCodePoints(normalizeUnicode(C_CEDILLA_DECOMPOSED));
        expect(before).toBe(2);
        expect(after).toBe(1);
        expect(after).toBeLessThan(before);
    });

    it('a sentence shifts every position after the first decomposed letter', () => {
        const raw = 'A a' + C_CEDILLA_DECOMPOSED + A_TILDE_DECOMPOSED + 'o vale.';
        const normalized = normalizeUnicode(raw);
        expect(countCodePoints(raw) - countCodePoints(normalized)).toBe(2);
        // "vale" starts two code points later in the raw text than in the
        // normalized one. A span computed on one is wrong on the other.
        const rawIdx = Array.from(raw).indexOf('v');
        const normIdx = Array.from(normalized).indexOf('v');
        expect(rawIdx - normIdx).toBe(2);
    });
});
