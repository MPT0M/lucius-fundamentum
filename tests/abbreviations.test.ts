import { describe, it, expect } from 'vitest';
import { maskAbbreviationPeriods, PT_BR_ABBREVIATIONS, type AbbreviationList } from '../src/abbreviations.js';
import { MASK_CHAR } from '../src/math.js';
import { countCodePoints } from '../src/unicode.js';
import { chunk } from '../src/chunker.js';

/** Sentences as the chunker sees them, one per chunk (budget of one code point). */
const sentences = (text: string, abbreviations?: AbbreviationList) =>
    chunk({ id: 'd', title: 'd', text }, { maxChunkCodePoints: 1, maxOverlapCodePoints: 0, ...(abbreviations ? { abbreviations } : {}) })
        .map((c) => c.text);

describe('maskAbbreviationPeriods — the period after a title stops ending the sentence', () => {
    // The plain "Dr. Silva" case lives in chunker.test.ts, where it was the
    // declared gap; this file covers the shapes around it.
    it('protects a run of titles before a name', () => {
        expect(sentences('O Exmo. Sr. Dr. Juiz decidiu. Recorreremos.')).toEqual([
            'O Exmo. Sr. Dr. Juiz decidiu.',
            'Recorreremos.',
        ]);
    });

    it('protects an initial before a surname', () => {
        expect(sentences('Assinado por J. Silva hoje. Arquivado.')).toEqual(['Assinado por J. Silva hoje.', 'Arquivado.']);
    });

    it('a list entry with an interior period is reachable ("i.e", "e.g")', () => {
        // Without interior periods in the word class these two entries could
        // never match: the lookbehind refuses a word that starts after a dot.
        expect(PT_BR_ABBREVIATIONS.always.has('i.e')).toBe(true);
        const text = 'Dois, i.e. Ambos.';
        expect(maskAbbreviationPeriods(text).spans).toEqual([{ start: 9, end: 10 }]);
    });

    it('a Roman numeral is ALWAYS protected — even at a real sentence end (inherited trade-off)', () => {
        // The source list puts I..XX in the unconditional class, so "II." before
        // a capital is never a boundary. Pinned so the behaviour is a documented
        // decision and not a surprise; a caller who disagrees passes a list
        // without the numerals.
        expect(PT_BR_ABBREVIATIONS.always.has('II')).toBe(true);
        expect(sentences('Reinou Pedro II. Depois veio a República.')).toEqual(['Reinou Pedro II. Depois veio a República.']);
    });

    it('a title before an opening quote or parenthesis is protected too', () => {
        // Measured before the fix: Intl.Segmenter cuts after "Dr." in all three
        // shapes exactly as it does before a bare capital, and the mask tested
        // the quote instead of the letter. Moses skips opening punctuation for
        // the same reason.
        expect(sentences('O Dr. "Silva" chegou. Fim.')).toEqual(['O Dr. "Silva" chegou.', 'Fim.']);
        expect(sentences('O Dr. (Silva) chegou. Fim.')).toEqual(['O Dr. (Silva) chegou.', 'Fim.']);
        expect(sentences('O Dr. \u201CSilva\u201D chegou. Fim.')).toEqual(['O Dr. \u201CSilva\u201D chegou.', 'Fim.']);
        // An unlisted word before a quote still ends the sentence.
        expect(sentences('Ela veio. "Foi" embora.')).toEqual(['Ela veio.', '"Foi" embora.']);
    });

    it('masks exactly one code point per abbreviation: the period', () => {
        const text = 'O Dr. Silva e a Dra. Souza.';
        const { text: masked, spans } = maskAbbreviationPeriods(text);
        expect(spans).toEqual([{ start: 4, end: 5 }, { start: 19, end: 20 }]);
        expect(Array.from(masked)[4]).toBe(MASK_CHAR);
        expect(Array.from(masked)[19]).toBe(MASK_CHAR);
        expect(countCodePoints(masked)).toBe(countCodePoints(text));
        // The words survive untouched — they still index.
        expect(masked).toContain('Dr');
        expect(masked).toContain('Dra');
    });
});

describe('maskAbbreviationPeriods — what it deliberately does NOT protect', () => {
    it('a listed word followed by a lowercase letter is left alone (no boundary to prevent)', () => {
        const text = 'Ver art. cinco da lei.';
        expect(maskAbbreviationPeriods(text)).toEqual({ text, spans: [] });
    });

    it('"etc." is not in the list and still ends a sentence', () => {
        // Deliberate: etc. ends a sentence about half the time. Protecting it
        // would trade one defect for its mirror image.
        expect(PT_BR_ABBREVIATIONS.always.has('etc')).toBe(false);
        expect(sentences('Comprei pão, leite, etc. Depois fui embora.')).toEqual([
            'Comprei pão, leite, etc.',
            'Depois fui embora.',
        ]);
    });

    it('a NUMERIC_ONLY prefix protects only before a digit', () => {
        expect(PT_BR_ABBREVIATIONS.numericOnly.has('No')).toBe(true);
        // Asserted on the mask, not through the chunker: Intl.Segmenter already
        // refuses to cut before a digit, so through the chunker the mutant
        // "numericOnly ignored" survives. The class exists for an injected
        // segmenter that does not have that rule.
        expect(maskAbbreviationPeriods('Veja o No. 5 da lista.').spans).toEqual([{ start: 9, end: 10 }]);
        // Before a capital: "No." is a word on its own, the period ends it.
        expect(maskAbbreviationPeriods('Disse No. Ele foi.').spans).toEqual([]);
    });

    it('a prefix in both classes follows the NUMERIC_ONLY rule', () => {
        // "Art" and "p" are in `always` AND `numericOnly` in the source. The
        // stricter class wins, as the Moses loader's last assignment would; a
        // regenerated list that inverted this would fail here.
        expect(PT_BR_ABBREVIATIONS.always.has('Art') && PT_BR_ABBREVIATIONS.numericOnly.has('Art')).toBe(true);
        expect(PT_BR_ABBREVIATIONS.always.has('p') && PT_BR_ABBREVIATIONS.numericOnly.has('p')).toBe(true);
        expect(maskAbbreviationPeriods('Ver Art. 5 da lei.').spans).toEqual([{ start: 7, end: 8 }]);
        expect(maskAbbreviationPeriods('Ver Art. Depois.').spans).toEqual([]);
        expect(maskAbbreviationPeriods('Ver p. 45 do livro.').spans).toEqual([{ start: 5, end: 6 }]);
        expect(maskAbbreviationPeriods('Ver p. Depois.').spans).toEqual([]);
    });

    it('a word that is not listed is not protected, even before a capital', () => {
        expect(sentences('Ela veio. Foi embora.')).toEqual(['Ela veio.', 'Foi embora.']);
    });

    it('does not match inside a longer word', () => {
        // "Dr" is listed; "Endr." is not "Dr." — the lookbehind requires a
        // word boundary before the abbreviation.
        expect(maskAbbreviationPeriods('Endr. Silva').spans).toEqual([]);
    });
});

describe('maskAbbreviationPeriods — the list is injectable', () => {
    it('an empty list disables protection', () => {
        const none: AbbreviationList = { always: new Set(), numericOnly: new Set() };
        expect(sentences('O Dr. Silva chegou. Fim.', none)).toEqual(['O Dr.', 'Silva chegou.', 'Fim.']);
    });

    it('a custom list adds what the default lacks', () => {
        const withPe: AbbreviationList = {
            always: new Set([...PT_BR_ABBREVIATIONS.always, 'Pe']),
            numericOnly: PT_BR_ABBREVIATIONS.numericOnly,
        };
        expect(sentences('O Pe. Antônio rezou. Todos saíram.')).toEqual(['O Pe.', 'Antônio rezou.', 'Todos saíram.']);
        expect(sentences('O Pe. Antônio rezou. Todos saíram.', withPe)).toEqual(['O Pe. Antônio rezou.', 'Todos saíram.']);
    });

    it('the exported default object cannot be swapped out (its sets are read-only by type only)', () => {
        expect(Object.isFrozen(PT_BR_ABBREVIATIONS)).toBe(true);
    });
});
