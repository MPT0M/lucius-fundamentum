import { describe, it, expect } from 'vitest';
import { maskProtectedRegions } from '../src/mask.js';
import { MASK_CHAR, type MaskResult } from '../src/math.js';
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

describe('maskProtectedRegions — abbreviations come last', () => {
    it('an abbreviation inside code, a URL or a formula belongs to the outer region', () => {
        // Each text has exactly ONE protected region; a second span of one code
        // point would mean the abbreviation pass saw a period it should not.
        for (const text of ['x `Dr. Silva` y', 'x https://dr.example/Dr. y', 'x $Dr. X$ y']) {
            const { spans } = maskProtectedRegions(text);
            expect(spans, text).toHaveLength(1);
        }
        // And outside those regions the same word is still protected.
        // Deliberate contract change (lot 2): spans now carry `kind`. The old
        // assertion fixed the exact set of keys, which was more than the
        // contract promised; the position it pinned is unchanged.
        expect(maskProtectedRegions('O Dr. Silva').spans).toEqual([{ start: 4, end: 5, kind: 'abbreviation' }]);
    });
});

describe('maskProtectedRegions — every region says which pass painted it', () => {
    it('code, URL, formula and abbreviation each come back with their own kind', () => {
        const text = 'Veja `a.b`, https://x.y/z, $x^2$ e o Dr. Silva.';
        const { spans } = maskProtectedRegions(text);
        expect(spans.map((s) => s.kind)).toEqual(['code', 'url', 'formula', 'abbreviation']);
        expect(spans.map((s) => at(text, s))).toEqual(['`a.b`', 'https://x.y/z', '$x^2$', '.']);
    });

    it('a fenced block and an inline span are both "code"', () => {
        const { spans } = maskProtectedRegions('```\nx\n``` e `y`');
        expect(spans.map((s) => s.kind)).toEqual(['code', 'code']);
    });

    it('kinds stay attached after the final sort by position', () => {
        // The abbreviation pass runs last but its period sits FIRST in this
        // text; sorting must move the span, not detach its kind.
        const text = 'Dr. X e $y$';
        const { spans } = maskProtectedRegions(text);
        expect(spans.map((s) => [at(text, s), s.kind])).toEqual([['.', 'abbreviation'], ['$y$', 'formula']]);
    });

    it('the classified result is a MaskResult — readers of start/end are untouched', () => {
        // Assignability is guaranteed by the declaration itself —
        // `ClassifiedMaskResult extends MaskResult` in src/mask.ts — so there is
        // no type-level assertion here that could fail on its own. This
        // assignment is what a caller of the old contract does, and the
        // positions it reads are unchanged. What `tsc` over tests/ actually
        // guards in this file are the `s.kind` reads: their only check is the
        // declared type — widen the return type back to `MaskResult` and every
        // one of them stops compiling, while the runtime value is still there.
        const asPlain: MaskResult = maskProtectedRegions('O Dr. Silva');
        expect(asPlain.spans[0]).toMatchObject({ start: 4, end: 5 });
    });

    // Declared debt, kept visible the way the chunker kept "Dr. Silva" visible
    // until the abbreviation list landed. The URL pattern accepts `$` and a
    // backtick inside a URL (5411978), so a URL glued to a formula delimiter
    // swallows the delimiter — and now says so with a label. Fixing the pattern
    // changes masking behaviour and is a separate decision; this test turns
    // green the day it is taken.
    it.fails('a URL glued to a formula delimiter reports the delimiter as url — debt from 5411978', () => {
        const text = 'https://x.y$a$';
        const { spans } = maskProtectedRegions(text);
        expect(spans.map((s) => s.kind)).toEqual(['url', 'formula']);
        expect(at(text, spans[0]!)).toBe('https://x.y');
    });
});
