import { describe, it, expect } from 'vitest';
import { sentencesOf, trimmedSpan, defaultSegmenter } from '../src/sentences.js';
import { MASK_CHAR } from '../src/math.js';
import { sliceByCodePoints } from '../src/unicode.js';

const seg = defaultSegmenter();

/** What the caller reads back, which is what a citation would show. */
function texts(text: string): string[] {
    return sentencesOf(text, seg).map((s) => sliceByCodePoints(text, s.start, s.end));
}

describe('sentencesOf — the boundary the chunker and the attributor share', () => {
    it('a period that ends an abbreviation does not end a sentence', () => {
        expect(texts('Segundo o art. 5º da lei, o prazo corre. O réu recorreu.')).toEqual([
            'Segundo o art. 5º da lei, o prazo corre.',
            'O réu recorreu.',
        ]);
    });

    it('a period inside a formula does not end a sentence', () => {
        const out = texts('A identidade $x = 1.$ vale sempre. Depois vem o resto.');
        expect(out).toEqual(['A identidade $x = 1.$ vale sempre.', 'Depois vem o resto.']);
    });

    it('a period inside a URL does not end a sentence', () => {
        const out = texts('Veja https://exemplo.com.br/a.b para o detalhe. Fim.');
        expect(out).toEqual(['Veja https://exemplo.com.br/a.b para o detalhe.', 'Fim.']);
    });

    it('spans are code point offsets into the RAW text, astral characters included', () => {
        // 💡 is one code point and two UTF-16 units: a span measured in units
        // would slice one short from here on.
        const text = '💡 A ideia vem antes. A prova vem depois.';
        expect(texts(text)).toEqual(['💡 A ideia vem antes.', 'A prova vem depois.']);
    });

    it('the span excludes the whitespace the segmenter hands back with the sentence', () => {
        const text = 'Uma frase.   Outra frase.';
        const [first] = sentencesOf(text, seg);
        expect(sliceByCodePoints(text, first!.start, first!.end)).toBe('Uma frase.');
        expect(first!.end).toBe(10);
    });
});

describe('trimmedSpan — the bound is the sentence, not what surrounds it', () => {
    it('a segment that is only whitespace produces no sentence', () => {
        expect(trimmedSpan('   \n\t ', 0)).toBeNull();
    });

    it('the mask character is not whitespace, so a formula-only sentence keeps its extent', () => {
        // A sentence that masked down to nothing but the mask character has to
        // survive: it is a real sentence of the source, and dropping it would
        // silently remove a citable stretch.
        const onlyFormula = MASK_CHAR.repeat(5);
        expect(trimmedSpan(onlyFormula, 7)).toEqual({ start: 7, end: 12 });
    });

    it('the offset is added to both ends, so the span lands where the caller says', () => {
        expect(trimmedSpan('  frase  ', 100)).toEqual({ start: 102, end: 107 });
    });
});
