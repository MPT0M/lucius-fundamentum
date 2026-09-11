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
 * published algorithm over the same 2,739 plurals, 40 come out different —
 * 1.5% — and the composition matters more than the number.
 *
 * Thirty-five are pre-1943 spellings from a 19th-century novel (`taes`,
 * `moraes`, `sinaes`) that RSLP never handled either: it gives `tae` where
 * this gives `tao`, and the modern singular `tal` is out of reach for both.
 * They do not occur in contemporary Portuguese.
 *
 * Of the five that remain, FOUR are cases where this table does better than
 * the published one applied to folded text: `arvores` reaches `arvore` and
 * meets its singular where the published rules give `arvor`; `lapis` stays
 * whole where they give `lapil`; `pais` stays whole where they give `pal`;
 * `dois` stays whole where they give `doi`, the term of `dói`. The fifth,
 * `más`, keeps its `s` where the published rules reduce it — the folded form
 * collides with the conjunction `mas`, and leaving both alone costs a
 * reduction rather than producing a wrong term.
 *
 * TWO KINDS OF REPAIR, AND ONE CLASS THAT IS NOT CLOSED
 *
 * The exceptions below that are not in the published table fall into two
 * groups, and the distinction is the criterion for adding any more.
 *
 * The first group exists because FOLDING created the problem: `depois` and
 * `pais` reach rules in accent-free space that they never reached with their
 * accents, so an exception that covered one rule stopped being enough.
 *
 * The second exists because the output COLLIDES WITH A DIFFERENT WORD.
 * `mães` became `mao`, which is `mão`; `dois` became `doi`, which is `dói`.
 * That is not the same as a truncation: `pois` gives `poi` and `ações` gives
 * `acoe`, and neither is a word, so query and document truncate alike and
 * still meet. A collision does not truncate — it sends two different words to
 * one term, and a search for one retrieves the other. Truncation preserves
 * matching; collision manufactures false matches.
 *
 * So the rule for adding an exception is: repair a collision with a real
 * word, tolerate a truncation into a non-word. It is deliberately not "repair
 * what our folding broke" — that criterion is about blame, and blame does not
 * change the damage. `mães` is a defect of the published table and is
 * repaired anyway.
 *
 * THE CLASS IS NOT CLOSED, and pretending otherwise would be the dishonest
 * part. Measured over the four corpora, 12,188 folded terms hold 1,219 pairs
 * of the shape `W` and `W + s` that this stemmer merges. Nearly all are
 * genuine singular/plural. Two are collisions. The other 1,217 are
 * indistinguishable without a dictionary, because `doi`/`dois` has exactly
 * the same shape as `casa`/`casas` — there is no lexical signal, only lexical
 * knowledge.
 *
 * They are not hunted, for a reason that is about cost and not about
 * confidence: finding one needs a dictionary this package does not have and
 * will not carry, while fixing one costs a line in a list. When the cost of
 * search so exceeds the cost of repair, waiting is the correct strategy.
 * And the real mitigation is not this list — BM25 scores chunks of a couple
 * hundred tokens, where the other terms of the query outweigh one term
 * landing on the wrong stem.
 *
 * A note on how the two known cases were found, because it bears on the
 * above: neither was found by searching. `mães` came out of an audit reading
 * the table, `dois` out of the owner testing the criterion against an example
 * this very comment had used to argue the opposite. Neither collision even
 * occurs in the measured corpora — both words are there, their partners are
 * not. The repair is right because the collision is real in the language; the
 * urgency was rhetorical.
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
    {
        suffix: 'aes',
        minStem: 1,
        replacement: 'ao',
        // The published table lists `mãe` here. That exception is unreachable:
        // the step only sees words ending in `s`, and this rule only sees
        // words ending in `ães`, so a singular can never be tested against it.
        // The authors evidently meant the plural. Left as published, `mães`
        // folds to `maes`, takes this rule and becomes `mao` — the same term
        // as `mão`, a different word. `maes` is here instead, so the plural
        // falls through to the `s` rule and reaches `mae`, meeting its own
        // singular.
        exceptions: new Set(['maes']),
    },
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
            // `dois` is protected on `is` in the published table and not
            // here, so it reached this rule and became `doi` — which folded
            // is `dói`, the verb. Same shape as `pais`: an exception that
            // covers one rule and not the next one the word can reach.
            'dois',
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
