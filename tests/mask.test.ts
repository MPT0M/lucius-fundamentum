import { describe, it, expect } from 'vitest';
import { maskProtectedRegions } from '../src/mask.js';
import { MASK_CHAR } from '../src/math.js';
import { countCodePoints, sliceByCodePoints } from '../src/unicode.js';

const at = (text: string, s: { start: number; end: number }) => sliceByCodePoints(text, s.start, s.end);

describe('maskProtectedRegions — code and URLs are protected by the same rule as formulas', () => {
    it('a fenced code block is one region, even with a formula-looking dollar inside', () => {
        const text = 'Veja:\n```js\nconst p = $x$ + a.b;\n```\nFim.';
        const { spans } = maskProtectedRegions(text);
        expect(spans).toHaveLength(1);
        expect(at(text, spans[0]!)).toBe('```js\nconst p = $x$ + a.b;\n```');
    });

    it('inline code with a period inside is one region', () => {
        const text = 'Chame `obj.method()` antes. Depois siga.';
        const { spans } = maskProtectedRegions(text);
        expect(spans.map((s) => at(text, s))).toEqual(['`obj.method()`']);
    });

    it('a URL with periods and a path is one region, and trailing punctuation stays outside', () => {
        const text = 'Leia https://example.com/a.b/c. Depois volte.';
        const { spans } = maskProtectedRegions(text);
        expect(spans.map((s) => at(text, s))).toEqual(['https://example.com/a.b/c']);
    });

    it('formula, code and URL in one text: three regions, in order', () => {
        const text = 'Vale $x = 1.5$ em `f.g()` via https://a.b/c. Fim.';
        const { spans } = maskProtectedRegions(text);
        expect(spans.map((s) => at(text, s))).toEqual(['$x = 1.5$', '`f.g()`', 'https://a.b/c']);
    });

    it('a dollar inside code is code, not a formula — order of masking decides this', () => {
        // If formulas were masked first, `$a$` would be claimed as a formula and
        // the code span skipped as overlapping. Code must win.
        const text = 'Preço em `$a$ + $b$` hoje.';
        const { spans } = maskProtectedRegions(text);
        expect(spans).toHaveLength(1);
        expect(at(text, spans[0]!)).toBe('`$a$ + $b$`');
    });

    it('text with nothing to protect comes back untouched', () => {
        const text = 'Só prosa. Mais prosa.';
        expect(maskProtectedRegions(text)).toEqual({ text, spans: [] });
    });
});

describe('maskProtectedRegions — the same invariants as maskFormulas', () => {
    const samples = [
        'Veja:\n```js\nconst p = $x$ + a.b;\n```\nFim.',
        'Chame `obj.method()` antes. Depois siga.',
        'Leia https://example.com/a.b/c. Depois volte.',
        'Vale $x = 1.5$ em `f.g()` via https://a.b/c 💡 e 𝒳. Fim.',
    ];

    it('never changes the number of code points', () => {
        for (const text of samples) {
            expect(countCodePoints(maskProtectedRegions(text).text)).toBe(countCodePoints(text));
        }
    });

    it('masks exactly the spans and nothing else', () => {
        for (const text of samples) {
            const { text: masked, spans } = maskProtectedRegions(text);
            const orig = Array.from(text);
            const out = Array.from(masked);
            for (let i = 0; i < orig.length; i++) {
                const inside = spans.some((s) => i >= s.start && i < s.end);
                expect(out[i]).toBe(inside ? MASK_CHAR : orig[i]);
            }
        }
    });

    it('spans are sorted and disjoint', () => {
        for (const text of samples) {
            const { spans } = maskProtectedRegions(text);
            for (let i = 1; i < spans.length; i++) {
                expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
            }
        }
    });

    it('a code block containing sentence ends segments exactly like a single word would', () => {
        // The block holds three sentence ends. Masked, it must behave like one
        // opaque token — so the segmenter sees the same number of sentences as
        // it would in the same text with a plain word in the block's place.
        // Comparing against that twin, rather than against a fixed number,
        // makes the test independent of how the runtime treats the newlines
        // around the block.
        const withBlock = 'Rode isto:\n```\nfoo. Bar. Baz.\n```\nE pronto.';
        const withWord = 'Rode isto:\nCODEBLOCK\nE pronto.';
        const seg = new Intl.Segmenter('pt-BR', { granularity: 'sentence' });
        const count = (s: string) => Array.from(seg.segment(s)).filter((x) => x.segment.trim()).length;
        expect(count(maskProtectedRegions(withBlock).text)).toBe(count(withWord));
        // And unmasked, the block DOES add sentences — that is the defect.
        expect(count(withBlock)).toBeGreaterThan(count(withWord));
    });
});
