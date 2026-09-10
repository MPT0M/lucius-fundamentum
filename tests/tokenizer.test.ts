import { describe, it, expect } from 'vitest';
import { createTokenizer, foldForIndex, type Stemmer } from '../src/tokenizer.js';
import { maskProtectedRegions } from '../src/mask.js';
import { sliceByCodePoints, countCodePoints } from '../src/unicode.js';

const intl = createTokenizer();
/** The Unicode-class path, which is what runs where `Intl.Segmenter` is absent. */
const byClass = createTokenizer({ segmenter: null });

const terms = (text: string, t = intl) => t.tokenize(text).map((x) => x.term);

describe('tokenizer — the span points at the raw text, always', () => {
    it('every token slices back from the ORIGINAL and folds to its own term', () => {
        const text = 'A Lei 8.078/90 custa R$ 2.000,00 e vale desde 2026-09-09. Não é pouco.';
        for (const token of intl.tokenize(text)) {
            const slice = sliceByCodePoints(text, token.span.start, token.span.end);
            expect(foldForIndex(slice)).toBe(token.term);
        }
    });

    it('composed and decomposed accents give the same term from spans of different length', () => {
        const composed = 'coração do autor';
        const decomposed = composed.normalize('NFD');
        // The point of the whole ordering: the sources differ in length, so the
        // spans must differ too, while the terms must not.
        expect(countCodePoints(decomposed)).toBeGreaterThan(countCodePoints(composed));
        expect(terms(decomposed)).toEqual(terms(composed));

        const first = intl.tokenize(decomposed)[0]!;
        expect(first.span.end).toBe(countCodePoints('coração'.normalize('NFD')));
        expect(foldForIndex(sliceByCodePoints(decomposed, first.span.start, first.span.end))).toBe('coracao');
    });

    it('a term is never empty', () => {
        for (const token of intl.tokenize('Olá!  ...  «mundo» — 42.')) {
            expect(token.term.length).toBeGreaterThan(0);
        }
    });

    it('a combining mark with no letter to attach to emits nothing, on both paths', () => {
        // The fallback counts marks as word characters so a decomposed accent
        // does not split its own word. A mark standing alone therefore forms a
        // range, and folding strips it to the empty string — which the length
        // guard drops instead of indexing a term nobody can search for.
        for (const t of [intl, byClass]) {
            expect(t.tokenize('̃').map((x) => x.term)).toEqual([]);
            expect(t.tokenize('palavra ̃ teste').map((x) => x.term)).toEqual(['palavra', 'teste']);
        }
    });
});

describe('tokenizer — what comes out of each form', () => {
    /**
     * The table of the search spec. `Lei 8.078/90` is the example the plan
     * uses to justify a lexical arm existing at all.
     */
    it.each([
        ['Artigo 5º', ['artigo', '5º']],
        ['CDC', ['cdc']],
        ['Lei 8.078/90', ['lei', '8.078/90']],
        // Declared debt: `R$` leaves a bare `r` in the index, because `$` is
        // punctuation and `R` is a letter. It is noise, not a wrong answer —
        // a one-letter term in a corpus that mentions money has a document
        // frequency high enough for BM25 to grade it to almost nothing. If a
        // currency corpus ever shows it mattering, the fix is a region kind,
        // not a special case here.
        ['R$ 2.000,00', ['r', '2.000,00']],
        ['7.15', ['7.15']],
        ['2026-09-09', ['2026-09-09']],
        ['12:30', ['12:30']],
    ])('%s', (input, expected) => {
        expect(terms(input)).toEqual(expected);
    });

    it('the ordinal indicator survives, because the package folds with NFC and not NFKC', () => {
        // NFKC would turn `5º` into `5o`, and "artigo 5º" and "artigo 5o" are
        // different things to someone reading a law.
        expect(terms('Artigo 5º')).toContain('5º');
    });

    it('the word does NOT glue to the number', () => {
        // The anti-pattern, as a negative case. Gluing manufactures a term so
        // sparse that `Lei nº 8.078`, `Lei 8.078/90` and `8.078` stop finding
        // each other, and buys no rarity the number did not already have.
        expect(terms('Lei 8.078/90')).not.toContain('lei 8.078/90');
        expect(terms('Lei 8.078/90')).toHaveLength(2);
    });

    it('a separator with no digit on both sides does not join anything', () => {
        expect(terms('educação-digital')).toEqual(['educacao', 'digital']);
        expect(terms('art. 5')).toEqual(['art', '5']);
    });

    it('no stop word is removed: "não" survives', () => {
        // Removing it would be the difference between "sustenta" and
        // "contradiz". BM25 grades a ubiquitous term to nearly zero on its own.
        expect(terms('não sustenta o argumento')).toEqual(['nao', 'sustenta', 'o', 'argumento']);
    });
});

describe('tokenizer — the two segmentation paths', () => {
    const AGREE = ['Lei 8.078/90', 'R$ 2.000,00', '7.15', '2026-09-09', '12:30', 'Artigo 5º', 'educação'];

    it.each(AGREE)('agree on %s', (input) => {
        expect(terms(input, byClass)).toEqual(terms(input, intl));
    });

    /**
     * Declared divergence, pinned so it is not discovered by whoever changes
     * runtime. UAX #29 joins digits across `;`, `⁄` and `٫`; our fusion pass
     * does not list them, and it only fuses — it never splits. So the `Intl`
     * path keeps them whole and the class path does not.
     */
    it.each([
        ['1;2', ['1;2'], ['1', '2']],
        ['1⁄2', ['1⁄2'], ['1', '2']],
        ['1٫2', ['1٫2'], ['1', '2']],
    ])('diverge on %s, and the difference is pinned', (input, withIntl, withClass) => {
        expect(terms(input, intl)).toEqual(withIntl);
        expect(terms(input, byClass)).toEqual(withClass);
    });
});

describe('tokenizer — protected regions', () => {
    const CODE = 'antes `const x = foo_bar(1)` depois';
    const URL = 'veja https://nihilo.dev/a?b=1 agora';

    it('a code region is one token, spanning exactly the region', () => {
        const { spans } = maskProtectedRegions(CODE);
        const region = spans.find((s) => s.kind === 'code')!;
        const token = intl.tokenize(CODE).find((t) => t.span.start === region.start)!;
        expect(token.span).toEqual({ start: region.start, end: region.end });
        expect(terms(CODE)).toHaveLength(3);
    });

    it('a URL is one token and does not shatter on its punctuation', () => {
        expect(terms(URL)).toEqual(['veja', 'https://nihilo.dev/a?b=1', 'agora']);
    });

    it('an abbreviation is NOT an atom: the word stays indexable and no "." is emitted', () => {
        // The protected region there is the period alone. Treating it as an
        // atom would put a term of "." in every posting list in the corpus.
        const out = terms('Escreveu o Dr. Silva ontem.');
        expect(out).toEqual(['escreveu', 'o', 'dr', 'silva', 'ontem']);
        expect(out).not.toContain('.');
    });

    it('a separator touching the edge of an atom does not extend it', () => {
        // The region has to END IN A DIGIT for this to test the atom guard at
        // all: with any other last character the fusion is already refused by
        // the digit rule, and the test would pass without the guard existing.
        // No region the mask produces today ends in a digit, so the span is
        // supplied by the caller — which is a shape `createIndex` uses anyway.
        const text = 'abc1-2def';
        const region = { start: 0, end: 4, kind: 'code' } as const;
        const [first, second] = intl.tokenize(text, [region]);
        expect(first!.span).toEqual({ start: 0, end: 4 });
        expect(first!.term).toBe('abc1');
        expect(second!.term).toBe('2def');
    });

    it('with and without spans give the same terms when no region crosses the boundary', () => {
        for (const text of [CODE, URL, 'Dr. Silva e a Lei 8.078/90']) {
            const { spans } = maskProtectedRegions(text);
            expect(intl.tokenize(text, spans).map((t) => t.term)).toEqual(terms(text));
        }
    });

    /**
     * The limit of that equivalence, pinned. A chunk holding half a fenced
     * block has no closing fence, so computing the regions from the chunk
     * alone cannot see the code. The caller that passes the document's spans
     * — recut to the chunk — is the one that gets it right, and this is why
     * `createIndex` passes them.
     */
    it('they diverge when a region is cut by the boundary, and the caller with spans wins', () => {
        const document = 'antes `const x = 1` depois';
        const chunk = document.slice(0, 14); // 'antes `const x'
        const cutRegion = maskProtectedRegions(document)
            .spans.filter((s) => s.kind === 'code')
            .map((s) => ({ ...s, end: Math.min(s.end, countCodePoints(chunk)) }));

        const alone = intl.tokenize(chunk).map((t) => t.term);
        const informed = intl.tokenize(chunk, cutRegion).map((t) => t.term);
        expect(alone).not.toEqual(informed);
        expect(alone).toEqual(['antes', 'const', 'x']);
        expect(informed).toEqual(['antes', '`const x']);
    });
});

describe('tokenizer — the id says what produced the terms', () => {
    const plural: Stemmer = { id: 'test-plural', stem: (t) => (t.endsWith('s') ? t.slice(0, -1) : t) };

    it('composes the stemmer, because a stemmer changes which terms exist', () => {
        expect(createTokenizer().id).toBe('standard+no-stemmer');
        expect(createTokenizer({ stemmer: plural }).id).toBe('standard+test-plural');
    });

    it('the stemmer receives a term already folded, so it does not fold again', () => {
        const seen: string[] = [];
        const spy: Stemmer = {
            id: 'spy',
            stem: (t) => {
                seen.push(t);
                return t;
            },
        };
        createTokenizer({ stemmer: spy }).tokenize('Educação PLURAIS');
        expect(seen).toEqual(['educacao', 'plurais']);
    });

    it('the stem is what enters the index, and the span still points at the raw word', () => {
        const t = createTokenizer({ stemmer: plural });
        const [token] = t.tokenize('professores');
        expect(token!.term).toBe('professore');
        expect(sliceByCodePoints('professores', token!.span.start, token!.span.end)).toBe('professores');
    });
});
