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

describe('sentencesOf — a numbered list is items, not numbers and leftovers', () => {
    it('a numbered item is one sentence, not the number and then the text', () => {
        // THE DEFECT THIS COVERS, measured on the real path before the fix:
        // `1. Um\n2. Dois\n3. Tres` came back as SIX units — "1.", "Um",
        // "2.", "Dois", "3.", "Tres" — half of them a numeral alone. A
        // citation landing on one showed the reader a number and nothing
        // else, and `chunker.ts` documents the same shape costing a real
        // search result once already.
        expect(texts('1. Um\n2. Dois\n3. Tres')).toEqual(['1. Um', '2. Dois', '3. Tres']);
    });

    it('roman numerals and letter items were never the defect and do not change', () => {
        // The control for the case above. These two pass for reasons that
        // predate this fix — `PT_BR_ABBREVIATIONS.always` carries I–XX and
        // every single letter, and `)` is `Pe`, which extends a terminator
        // rather than being one — so what this pins is the OUTPUT, not the
        // pass behind it. Widening the enumerator to roman numerals would
        // repaint the same period before the abbreviation pass runs, leave the
        // masked text identical, and leave these three unchanged.
        // `tests/mask.test.ts` pins the `kind`, which is where that widening
        // does show.
        expect(texts('I. Um\nII. Dois\nIII. Tres')).toEqual(['I. Um', 'II. Dois', 'III. Tres']);
        expect(texts('a) Um\nb) Dois\nc) Tres')).toEqual(['a) Um', 'b) Dois', 'c) Tres']);
    });

    it('a number in running prose still ends its sentence', () => {
        // The anchor is the whole reason the debt stays small: only a line
        // start counts as an enumerator. Without this the fix would swallow
        // every year, price and measurement that ends a sentence.
        expect(texts('Em 1985. O ano virou.')).toEqual(['Em 1985.', 'O ano virou.']);
    });

    it('a year opening a line stops ending its sentence, and that is the declared debt', () => {
        // The cost of anchoring to the line start, as behaviour. Before the
        // enumerator pass these were two sentences.
        // `'1985.\nO ano virou.'` is NOT the shape that pays: a newline is a
        // sentence break of its own under UAX #29, so the cut lands in the same
        // place whether the period is masked or not. The text has to continue on
        // the SAME line for anything to be lost.
        expect(texts('1985. O ano virou.')).toEqual(['1985. O ano virou.']);
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
