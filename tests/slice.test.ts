import { describe, it, expect } from 'vitest';
import { sliceByCodePoints, countCodePoints } from '../src/unicode.js';

describe('sliceByCodePoints — a boundary never falls inside a character', () => {
    it('matches String.slice on plain ASCII', () => {
        expect(sliceByCodePoints('Constituicao', 0, 5)).toBe('Const');
        expect(sliceByCodePoints('Constituicao', 5)).toBe('ituicao');
    });

    it('keeps an emoji whole where String.slice would split it', () => {
        const text = 'a💡b';                  // .length === 4, code points === 3
        // The naive cut lands between the emoji's two UTF-16 halves.
        const naive = text.slice(0, 2);
        expect(naive.length).toBe(2);
        expect(naive).not.toBe('a💡');
        // The code point cut takes the whole character.
        expect(sliceByCodePoints(text, 0, 2)).toBe('a💡');
        expect(sliceByCodePoints(text, 1, 2)).toBe('💡');
        expect(sliceByCodePoints(text, 2)).toBe('b');
    });

    it('keeps a mathematical letter whole', () => {
        const text = 'seja 𝒳 real';
        expect(sliceByCodePoints(text, 5, 6)).toBe('𝒳');
    });

    it('counts a decomposed ç as its own two code points, and can split them', () => {
        // The raw text is what the user wrote; if they wrote two code points,
        // the slice sees two. That is the point of not normalizing before
        // measuring. (Whether you WANT to split them is the chunker's problem.)
        // Built by code point: the literal form was recomposed by the editor
        // on save and the test passed vacuously until this was caught.
        const decomposed = String.fromCodePoint(0x63, 0x0327);
        expect(countCodePoints(decomposed)).toBe(2);
        expect(sliceByCodePoints(decomposed, 0, 1)).toBe('c');
    });

    it('round-trips: the slices of a partition rebuild the original', () => {
        const text = 'A ação é válida 💡 e 𝒳 também.';
        const n = countCodePoints(text);
        const cut = 7;
        expect(sliceByCodePoints(text, 0, cut) + sliceByCodePoints(text, cut, n)).toBe(text);
    });
});

describe('sliceByCodePoints — bounds are clamped, never thrown', () => {
    const text = 'abcde';

    it('an end past the text yields the suffix', () => {
        expect(sliceByCodePoints(text, 3, 999)).toBe('de');
    });

    it('a start past the text yields the empty string', () => {
        expect(sliceByCodePoints(text, 999)).toBe('');
    });

    it('a negative start counts from the end, as in String.slice', () => {
        expect(sliceByCodePoints(text, -2)).toBe('de');
        expect(sliceByCodePoints('a💡b', -2)).toBe('💡b');
    });

    it('a negative end counts from the end', () => {
        expect(sliceByCodePoints(text, 0, -1)).toBe('abcd');
    });

    it('end before start yields the empty string, not a throw', () => {
        expect(sliceByCodePoints(text, 4, 2)).toBe('');
    });

    it('a start below zero is clamped to zero', () => {
        expect(sliceByCodePoints(text, -999, 2)).toBe('ab');
    });

    it('the empty string slices to the empty string', () => {
        expect(sliceByCodePoints('', 0, 5)).toBe('');
    });
});
