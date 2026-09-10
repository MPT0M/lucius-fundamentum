/**
 * RSLP-S: plural reduction for Portuguese, and nothing else.
 *
 * The rules are Viviane Moreira Orengo and Christian Huyck's, published at
 * SPIRE 2001 as the first step of RSLP. RSLP-S is that step alone, which is
 * the variant the literature finds safest — the full algorithm cuts
 * derivation too (`estado` becomes `est`, `federal` becomes `feder`) and
 * measures worse under Okapi BM25 than no stemmer at all.
 *
 * The table below is NOT written from memory. It is a projection of the
 * published table, generated and checked against a reference implementation
 * by `scripts/rslp-oracle.py`, whose output is frozen in
 * `tests/fixtures/rslp-s-oracle.json` and asserted by the suite.
 *
 * WHY THE TABLE HAS NO ACCENTS, WHICH IS A DEPARTURE
 * --------------------------------------------------
 * The published rules are written in accented Portuguese: `ões` becomes `ão`.
 * This package folds accents before stemming, so the stemmer never sees an
 * `õ`. Applying the published table to folded text does not degrade the
 * result, it breaks it: `aberrações` arrives as `aberracoes`, no rule matches,
 * the generic `s` rule fires and emits `aberracoe`, which never meets the
 * singular `aberracao`. Measured over 2,739 distinct plurals of the corpora,
 * 148 of them — 5.4% — come out wrong that way, and the class hit hardest is
 * `-ções`, the most common plural ending in formal and legal Portuguese.
 *
 * The obvious repair is to stem before folding. It scores perfectly in a lab
 * and fails in use: a query typed without accents (which is common) stems to
 * `aberracoe` while the indexed document holds `aberracao`, so the two never
 * meet. Accent-insensitive matching is worth more than fidelity to a table.
 *
 * So the table is projected into the folded space. Measured against the
 * published algorithm over the same 2,739 plurals, 38 come out different —
 * 1.4% — and the composition matters more than the number.
 *
 * Thirty-four are pre-1943 spellings from a 19th-century novel (`taes`,
 * `moraes`, `sinaes`) that RSLP never handled either: it gives `tae` where
 * this gives `tao`, and the modern singular `tal` is out of reach for both.
 * They do not occur in contemporary Portuguese.
 *
 * Of the four that remain, THREE are cases where this table does better than
 * the published one applied to folded text: `arvores` reaches `arvore` and
 * meets its singular where the published rules give `arvor`; `lapis` stays
 * whole where they give `lapil`; `pais` stays whole where they give `pal`.
 * The fourth, `más`, keeps its `s` where the published rules reduce it — the
 * folded form collides with the conjunction `mas`, and leaving both alone
 * costs a reduction rather than producing a wrong term.
 *
 * The loss that remains has no lexical fix and is worth naming: folded,
 * `país` (a country, not a plural) and `pais` (the plural of `pai`) are the
 * same string. Protecting the word protects both, so the genuine plural stops
 * being reduced to `pai`. A missed match, not a wrong one — but a real cost
 * of doing this without syntax.
 *
 * Because this is a projection and not the published algorithm, the id says
 * so. An artifact that claims `rslp-s` when it ran something else is lying
 * about what produced its terms.
 */

import type { Stemmer } from './tokenizer.js';

interface PluralRule {
    /** Matched against the end of the folded term. */
    readonly suffix: string;
    /** The term must be at least `suffix.length + minStem` long for the rule to fire. */
    readonly minStem: number;
    readonly replacement: string;
    /** Whole words this rule must not touch. A hit here skips THIS rule and tries the next. */
    readonly exceptions?: ReadonlySet<string>;
}

/**
 * The published step 1, projected into the folded space. Order matters: the
 * first rule that matches wins and the step ends, so the longest suffixes come
 * first.
 *
 * Two transcriptions of the 2001 table disagree, and this follows NLTK's,
 * which is the superset: it carries `árvores` on `res` and `depois` on `s`
 * where `dfalbel/rslp`'s `steprules.txt` carries neither. There is no arbiter
 * — the authors' page does not publish the rules file and the implementation
 * it points at answers 403 — so the conservative reading wins, since an extra
 * exception can only protect a word and never destroy a correct stem.
 *
 * `éis` and `eis` collapse into one rule under folding; they had the same
 * minimum and the same replacement, so nothing is lost.
 */
const RULES: readonly PluralRule[] = [
    { suffix: 'ns', minStem: 1, replacement: 'm' },
    { suffix: 'oes', minStem: 3, replacement: 'ao' },
    { suffix: 'aes', minStem: 1, replacement: 'ao', exceptions: new Set(['mae']) },
    {
        suffix: 'ais',
        minStem: 1,
        replacement: 'al',
        // `pais` is the second repair the projection requires, and the same
        // shape as `depois` below. In accented space `país` ends in `ís` and
        // never reaches this rule, so the authors protected it on `s`; folded,
        // `ais` matches first and the exception on `s` is never consulted, and
        // the word becomes `pal` — a term that matches nothing. Protecting it
        // costs the genuine plural `pais` (of `pai`) its reduction to `pai`,
        // which is a missed match rather than a wrong one.
        exceptions: new Set(['cais', 'mais', 'pais']),
    },
    { suffix: 'eis', minStem: 2, replacement: 'el' },
    {
        suffix: 'ois',
        minStem: 2,
        replacement: 'ol',
        // NOT from the paper. In accented space `depois` could never reach the
        // `óis` rule, so it needed no exception there; the authors protected it
        // on `is` and on `s`. Folding lets `ois` match first, and without this
        // the word becomes `depol`. A repair the projection requires, marked as
        // such so nobody looks for it in the 2001 table.
        exceptions: new Set(['depois']),
    },
    {
        suffix: 'is',
        minStem: 2,
        replacement: 'il',
        // `pais` is here for the same reason it is on `ais`: an exception skips
        // ONE rule and the loop continues, so a word that matches three rules
        // once folded needs protecting on all three. In accented space `país`
        // ends in `ís` and matched only `s`, which is why one entry was enough
        // for the authors.
        exceptions: new Set([
            'lapis', 'cais', 'mais', 'crucis', 'biquinis', 'pois', 'depois', 'dois', 'leis', 'pais',
        ]),
    },
    { suffix: 'les', minStem: 3, replacement: 'l' },
    { suffix: 'res', minStem: 3, replacement: 'r', exceptions: new Set(['arvores']) },
    {
        suffix: 's',
        minStem: 2,
        replacement: '',
        exceptions: new Set([
            'alias', 'pires', 'lapis', 'cais', 'mais', 'mas', 'menos', 'ferias', 'fezes',
            'pesames', 'crucis', 'gas', 'atras', 'moises', 'atraves', 'conves', 'es',
            'pais', 'apos', 'ambas', 'ambos', 'messias', 'depois',
        ]),
    },
];

/** The step does not run at all below this, whatever the rules would say. */
const MIN_WORD_LENGTH = 3;

/**
 * Reduces a Portuguese plural to its singular, leaving everything else alone.
 *
 * Expects a term already folded by `foldForIndex`: lower case, no combining
 * marks. Pure and total.
 */
export function stemPlural(term: string): string {
    if (term.length < MIN_WORD_LENGTH || !term.endsWith('s')) return term;
    for (const rule of RULES) {
        if (!term.endsWith(rule.suffix)) continue;
        if (rule.exceptions?.has(term)) continue;
        if (term.length < rule.suffix.length + rule.minStem) continue;
        return term.slice(0, term.length - rule.suffix.length) + rule.replacement;
    }
    return term;
}

/**
 * The default stemmer: plural only.
 *
 * `rslp-s-folded` and not `rslp-s`, because the table it runs is a projection
 * of the published one into accent-free space. The id travels in the index
 * artifact, alone, far from this file.
 */
export const RSLP_S_FOLDED: Stemmer = {
    id: 'rslp-s-folded',
    stem: stemPlural,
};
