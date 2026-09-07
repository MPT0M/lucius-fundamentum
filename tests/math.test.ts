import { describe, it, expect } from 'vitest';
import { maskFormulas, MASK_CHAR } from '../src/math.js';
import { countCodePoints, sliceByCodePoints, normalizeUnicode } from '../src/unicode.js';

/** The formula text a span points at, read back from the ORIGINAL. */
function formulaAt(text: string, span: { start: number; end: number }): string {
    return sliceByCodePoints(text, span.start, span.end);
}

describe('maskFormulas — which stretches are formulas', () => {
    // These eight cases are the ones that separated three versions of the
    // inline pattern during design. The price-next-to-formula case is the only
    // one that tells "masked nothing" apart from "masked the wrong thing".
    const cases: ReadonlyArray<readonly [string, string, readonly string[]]> = [
        ['inline formula',          'Considere $x = 1.5$ como valor base.',              ['$x = 1.5$']],
        ['escaped price',           'O custo foi de $100 dolares e \\$200 adicionais.',  []],
        ['two prices in a sentence','De $100 a $200 reais.',                             []],
        ['price next to formula',   'Custa $50 reais e vale $x^2$ pontos.',              ['$x^2$']],
        ['three prices',            'Entre $10, $20 e $30 reais.',                       []],
        ['formula with currency',   'O valor $p = 5$ em dolares.',                       ['$p = 5$']],
        ['two formulas in a row',   'Temos $a=1$ e $b=2$ aqui.',                         ['$a=1$', '$b=2$']],
        ['accented formula',        'A $ação$ vale.',                                    ['$ação$']],
    ];

    for (const [name, text, expected] of cases) {
        it(`${name}: ${JSON.stringify(expected)}`, () => {
            const { spans } = maskFormulas(text);
            expect(spans.map((s) => formulaAt(text, s))).toEqual(expected);
        });
    }

    it('a display formula across lines is one region, not two inline ones', () => {
        const text = 'Logo,\n$$\n\\frac{a}{b} = c\n$$\ne pronto.';
        const { spans } = maskFormulas(text);
        expect(spans).toHaveLength(1);
        expect(formulaAt(text, spans[0]!)).toBe('$$\n\\frac{a}{b} = c\n$$');
    });

    it('a dollar inside a block is not also an inline match', () => {
        const text = 'Veja $$ a $ b $$ fim.';
        const { spans } = maskFormulas(text);
        expect(spans).toHaveLength(1);
    });

    it('text with no formula comes back untouched, with no spans', () => {
        const text = 'Nada de matematica aqui.';
        expect(maskFormulas(text)).toEqual({ text, spans: [] });
    });
});

describe('maskFormulas — the invariant the package is built on', () => {
    const samples = [
        'Considere $x = 1.5$ como valor base.',
        'Logo,\n$$\n\\frac{a}{b} = c\n$$\ne pronto.',
        'Temos $a=1$ e $b=2$ e um 💡 e $𝒳$ aqui.',
        'A $ação$ vale.',
    ];

    it('never changes the number of code points', () => {
        for (const text of samples) {
            expect(countCodePoints(maskFormulas(text).text)).toBe(countCodePoints(text));
        }
    });

    it('leaves everything outside the spans byte-identical', () => {
        for (const text of samples) {
            const { text: masked, spans } = maskFormulas(text);
            const orig = Array.from(text);
            const out = Array.from(masked);
            for (let i = 0; i < orig.length; i++) {
                const inside = spans.some((s) => i >= s.start && i < s.end);
                if (inside) expect(out[i]).toBe(MASK_CHAR);
                else expect(out[i]).toBe(orig[i]);
            }
        }
    });

    it('spans read back from the original give the formula, delimiters included', () => {
        const text = 'Temos $a=1$ e $b=2$ aqui.';
        const { spans } = maskFormulas(text);
        expect(spans.map((s) => formulaAt(text, s))).toEqual(['$a=1$', '$b=2$']);
        // Nothing to restore: the original is still there, the span is the key.
    });

    it('spans are in order and do not overlap', () => {
        const { spans } = maskFormulas('$a$ e $$b$$ e $c$');
        for (let i = 1; i < spans.length; i++) {
            expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
        }
    });
});

describe('maskFormulas — why U+E000 and not a space or a no-break space', () => {
    it('survives NFC and NFKC unchanged', () => {
        const run = MASK_CHAR.repeat(5);
        expect(normalizeUnicode(run)).toBe(run);
        expect(run.normalize('NFKC')).toBe(run);
        // For contrast: the no-break space does NOT survive NFKC.
        expect(' '.normalize('NFKC')).toBe(' ');
    });

    it('is not whitespace, so whitespace operations cannot change the length', () => {
        // The mutation this guards against: a mask made of spaces passes every
        // other test here and breaks the length invariant the first time a
        // consumer calls trim() or splits on whitespace.
        expect(/\s/.test(MASK_CHAR)).toBe(false);
        const text = '$a=1$ no começo e $b=2$ no fim $c=3$';
        const masked = maskFormulas(text).text;
        expect(countCodePoints(masked.trim())).toBe(countCodePoints(text));
        expect(masked.split(/\s+/).length).toBe(text.split(/\s+/).length);
    });

    it('creates no sentence boundary that the original did not have', () => {
        const text = 'Primeira frase com $x = 1.5$ dentro. Segunda frase.';
        const seg = new Intl.Segmenter('pt-BR', { granularity: 'sentence' });
        const count = (s: string) => Array.from(seg.segment(s)).length;
        expect(count(maskFormulas(text).text)).toBe(2);
        // The unmasked text is the problem: the `.` in `1.5` may or may not
        // split depending on the runtime — which is why the segmenter never
        // sees it.
    });

    it('the mask character is a single code point and not a surrogate half', () => {
        expect(countCodePoints(MASK_CHAR)).toBe(1);
        expect(MASK_CHAR.length).toBe(1);
    });
});
