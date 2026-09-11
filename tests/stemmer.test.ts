import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stemPlural, RSLP_S_FOLDED } from '../src/stemmer.js';
import { createTokenizer, foldForIndex } from '../src/tokenizer.js';

interface Oracle {
    readonly rules: readonly { suffix: string; minStem: number; replacement: string; exceptions: string[] }[];
    /** word -> what the PUBLISHED algorithm gives on accented input, then folded. */
    readonly pairs: Readonly<Record<string, string>>;
}

const oracle: Oracle = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/rslp-s-oracle.json', import.meta.url)), 'utf8'),
);

const stem = (w: string) => stemPlural(foldForIndex(w));

describe('stemmer — plural, and only plural', () => {
    it.each([
        ['casas', 'casa'],
        ['artigos', 'artigo'],
        ['estudantes', 'estudante'],
        ['bons', 'bom'],
        ['normais', 'normal'],
        ['papéis', 'papel'],
        ['lençóis', 'lencol'],
        ['informações', 'informacao'],
        ['capitães', 'capitao'],
        // One canonical case per rule that the oracle covers only in bulk.
        ['professores', 'professor'],
        ['fuzis', 'fuzil'],
        ['cônsules', 'consul'],
    ])('%s → %s', (plural, singular) => {
        expect(stem(plural)).toBe(singular);
    });

    it('leaves a singular alone', () => {
        for (const w of ['casa', 'artigo', 'educação', 'lei']) expect(stem(w)).toBe(foldForIndex(w));
    });

    it('does NOT cut derivation, which is the whole reason this is RSLP-S and not RSLP', () => {
        // Full RSLP takes `estado` to `est` and `federal` to `feder`, collapsing
        // words that mean different things. Measured under Okapi BM25 it scores
        // worse than no stemmer at all.
        for (const w of ['estado', 'estadual', 'federal', 'federação', 'educacional']) {
            expect(stem(w)).toBe(foldForIndex(w));
        }
        expect(stem('estados')).toBe('estado');
    });

    it('protects words that end in s without being plural', () => {
        for (const w of ['lápis', 'gás', 'atrás', 'através', 'menos', 'pires', 'férias', 'ambos']) {
            expect(stem(w)).toBe(foldForIndex(w));
        }
    });

    it('a word shorter than three code points is never touched', () => {
        for (const w of ['as', 'os', 'és']) expect(stem(w)).toBe(foldForIndex(w));
    });
});

describe('stemmer — the accent-free query meets the accented document', () => {
    /**
     * The property the folded table exists for. Typing without accents is
     * common, and a stemmer that only works on accented input silently hides
     * every plural in the corpus from those queries.
     */
    it.each([
        ['informações', 'informacoes'],
        ['aberrações', 'aberracoes'],
        ['decisões', 'decisoes'],
        ['condições', 'condicoes'],
        ['papéis', 'papeis'],
        ['capitães', 'capitaes'],
    ])('%s and %s reach the same term', (accented, plain) => {
        expect(stem(plain)).toBe(stem(accented));
    });

    it('and that term is the singular, not a truncation', () => {
        expect(stem('informacoes')).toBe('informacao');
        expect(stem('informação')).toBe('informacao');
    });
});

describe('stemmer — the repair the projection required', () => {
    /**
     * `depois` never reached the `óis` rule in accented space, so the authors
     * did not give that rule an exception for it. Folding lets `ois` match
     * first, and without the repair the word becomes `depol`.
     */
    it('depois survives, and would not without the exception on the ois rule', () => {
        expect(stem('depois')).toBe('depois');
    });

    it('the ois rule still does its job for the words it was written for', () => {
        expect(stem('lençóis')).toBe('lencol');
        expect(stem('faróis')).toBe('farol');
        expect(stem('anzóis')).toBe('anzol');
    });
});

describe('stemmer — a term that means something else is a different defect', () => {
    /**
     * Two repairs that are not in the published table and are not there
     * because folding broke something. They are there because the output was
     * a DIFFERENT WORD.
     *
     * The line is between collision and truncation. `pois` gives `poi` and
     * `ações` gives `acoe`: neither is a word, query and document truncate
     * alike, and they still meet. `mães` giving `mao` sends it to the term of
     * `mão`; `dois` giving `doi` sends it to the term of `dói`. Those are
     * false matches, not lost precision, and they are repaired even though
     * the published algorithm produces them.
     */
    it('mães meets its own singular instead of the term for mão', () => {
        expect(stem('mães')).toBe('mae');
        expect(stem('mãe')).toBe('mae');
        expect(stem('mão')).toBe('mao');
        expect(stem('mãos')).toBe('mao');
        expect(stem('mães')).not.toBe(stem('mãos'));
    });

    it('dois stays whole instead of landing on the term for dói', () => {
        expect(stem('dois')).toBe('dois');
        expect(stem('dói')).toBe('doi');
        expect(stem('dois')).not.toBe(stem('dói'));
    });

    it('the aes rule still fires for the words it was written for', () => {
        expect(stem('capitães')).toBe('capitao');
        expect(stem('alemães')).toBe('alemao');
    });

    it('a truncation into a non-word is left alone, on purpose', () => {
        // Both sides of a search truncate the same way, so they still meet.
        // Repairing these would diverge further from a published algorithm
        // for no gain in retrieval.
        expect(stem('pois')).toBe('poi');
        expect(stem('ações')).toBe('acoe');
    });
});

describe('stemmer — measured against the published algorithm', () => {
    /**
     * `tests/fixtures/rslp-s-oracle.json` is the published table applied to
     * accented input by a reference implementation, then folded — generated
     * by `scripts/rslp-oracle.py`, never typed by hand.
     *
     * The two are expected to disagree, because ours runs on folded input. The
     * test pins HOW MANY and WHICH, so the cost of the projection is a number
     * in the suite rather than a paragraph in a comment.
     */
    const words = Object.keys(oracle.pairs);

    it('the corpus vocabulary is large enough for this to mean something', () => {
        expect(words.length).toBeGreaterThan(2000);
    });

    it('agrees with the published algorithm on all but a pinned set', () => {
        const differ = words.filter((w) => stem(w) !== oracle.pairs[w]);
        const archaic = differ.filter((w) => foldForIndex(w).endsWith('aes'));
        const rest = differ.filter((w) => !foldForIndex(w).endsWith('aes')).sort();

        // Thirty-five pre-1943 spellings from the 19th-century novel, which
        // RSLP never handled either — it gives `tae` where we give `tao`, and
        // the modern `tal` is out of reach for both.
        expect(archaic).toHaveLength(35);

        // And exactly these five — four of which this table gets BETTER than
        // the published rules applied to folded text.
        expect(rest).toEqual(['arvores', 'dois', 'lapis', 'más', 'pais']);
    });

    it.each([
        ['arvores', 'arvore', 'arvor'],
        ['lapis', 'lapis', 'lapil'],
        ['pais', 'pais', 'pal'],
        ['dois', 'dois', 'doi'],
    ])('%s reaches %s here, where the published rules on folded text give %s', (word, ours, published) => {
        expect(stem(word)).toBe(ours);
        expect(oracle.pairs[word]).toBe(published);
    });

    it('país and pais are the same string once folded, and that is the cost', () => {
        // `país` is a country and not a plural; `pais` is the plural of `pai`.
        // No lexical rule can separate them without the accent, so protecting
        // the word protects both and the genuine plural stops reaching `pai`.
        // A missed match rather than a wrong term, which is the trade taken.
        expect(foldForIndex('país')).toBe(foldForIndex('pais'));
        expect(stem('país')).toBe('pais');
        expect(stem('pais')).toBe('pais');
    });
});

describe('stemmer — what the artifact will say it ran', () => {
    it('the id declares the projection, because it travels alone', () => {
        expect(RSLP_S_FOLDED.id).toBe('rslp-s-folded');
    });

    it('the tokenizer composes it', () => {
        expect(createTokenizer({ stemmer: RSLP_S_FOLDED }).id).toBe('standard+rslp-s-folded');
    });

    it('the stem enters the index while the span still points at the raw plural', () => {
        const [token] = createTokenizer({ stemmer: RSLP_S_FOLDED }).tokenize('informações');
        expect(token!.term).toBe('informacao');
        expect(token!.span).toEqual({ start: 0, end: 11 });
    });
});
