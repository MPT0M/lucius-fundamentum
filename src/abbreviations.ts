/**
 * Abbreviations whose trailing period does not end a sentence.
 *
 * A sentence segmenter reads "O Dr. Silva chegou." and stops after "Dr." —
 * period, space, capital letter is exactly what it calls a sentence end. The
 * fix is the same one used for formulas: hide the period from the segmenter
 * before it looks, without moving a position. Only the PERIOD is masked, as a
 * single code point, so the word stays indexable and the length is unchanged.
 *
 * THE LIST IS PARTIAL BY NATURE and this is declared, not hidden. Portuguese
 * abbreviates productively; no list closes. This one covers what the Moses
 * machine-translation project accumulated for pt over years of use — titles,
 * initials, Roman numerals, bibliographic prefixes — which is most of what
 * appears before a capitalized name in real text. It is INJECTABLE: pass your
 * own `AbbreviationList` to extend, replace or disable it. The measurement
 * harness in a later lot says how much the gaps cost.
 *
 * The exported default is frozen as an OBJECT, so it cannot be swapped out;
 * the two sets inside it are read-only by TYPE only. `Object.freeze` does not
 * stop `Set.prototype.add`, and a copy per call would be paid on every chunk
 * for a guard nobody has asked for. Mutating them at runtime changes the
 * default for every consumer in the process — build your own list instead.
 *
 * Three entries a Portuguese reader will look for are not here, and none was
 * removed: the source does not have them. `etc.` stays out on purpose — it ends
 * a sentence about half the time, so protecting it would create the opposite
 * defect; callers who want it add it. `Pe.` (Padre) and `séc.` (século) are
 * simply gaps of the source.
 *
 * One inherited trade-off is worth knowing before blaming the chunker: Roman
 * numerals and single letters are in `always`, so `Pedro II. Depois...` and
 * `nota A. Depois...` never break there, even when the period really ends the
 * sentence (except `p`, which is also `numericOnly` — see below). Moses chose
 * that because `cap. IV. O rei...` is the commoner case in the text it was
 * built for; a caller for whom it is not passes a list without them.
 *
 * SOURCE AND ATTRIBUTION. Derived from `nonbreaking_prefix.pt` as redistributed
 * by the NLTK project under the Apache License 2.0, itself adapted for
 * Portuguese by H. Leal Fontes from the Moses decoder's EN/DE lists
 * (moses-2009-04-13, last updated 2009-11-10). The list carries some English
 * carry-over (`Mrs`, `Sgt`) from that origin. See NOTICE.
 *
 * The 191 entries of the source are reproduced as 187 `always` literals plus
 * 4 `numericOnly`; the source repeats `i v x I V X` (once as a letter, once as
 * a numeral, `v` a third time), so `always` holds 180 distinct words. `Art`
 * and `p` appear in BOTH classes; see `maskAbbreviationPeriods` for who wins.
 */

import type { Span } from './types.js';
import { MASK_CHAR, type MaskResult } from './math.js';
import { countCodePoints } from './unicode.js';

export interface AbbreviationList {
    /**
     * Followed by a period and then a capitalized word or a digit: not a
     * sentence end. Case-sensitive — `Dr` and `dr` are separate entries.
     * A word that is also in `numericOnly` follows THAT rule, not this one.
     */
    readonly always: ReadonlySet<string>;
    /**
     * Followed by a period and then a DIGIT: not a sentence end. Followed by
     * anything else, the period IS a sentence end. The Moses `#NUMERIC_ONLY#`
     * class, for prefixes like `No.` that are also a word on their own.
     * Takes precedence over `always` when a word is in both.
     */
    readonly numericOnly: ReadonlySet<string>;
}

/** Generated from the source file; do not edit by hand — regenerate. */
export const PT_BR_ABBREVIATIONS: AbbreviationList = Object.freeze({
    always: new Set<string>([
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L',
    'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X',
    'Y', 'Z', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j',
    'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v',
    'w', 'x', 'y', 'z', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII',
    'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX',
    'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii',
    'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx', 'Adj', 'Adm', 'Adv', 'Art',
    'Ca', 'Capt', 'Cmdr', 'Col', 'Comdr', 'Con', 'Corp', 'Cpl', 'DR', 'DRA', 'Dr', 'Dra',
    'Dras', 'Drs', 'Eng', 'Enga', 'Engas', 'Engos', 'Ex', 'Exo', 'Exmo', 'Fig', 'Gen', 'Hosp',
    'Insp', 'Lda', 'MM', 'MR', 'MRS', 'MS', 'Maj', 'Mrs', 'Ms', 'Msgr', 'Op', 'Ord',
    'Pfc', 'Ph', 'Prof', 'Pvt', 'Rep', 'Reps', 'Res', 'Rev', 'Rt', 'Sen', 'Sens', 'Sfc',
    'Sgt', 'Sr', 'Sra', 'Sras', 'Srs', 'Sto', 'Supt', 'Surg', 'adj', 'adm', 'adv', 'art',
    'cit', 'col', 'con', 'corp', 'cpl', 'dr', 'dra', 'dras', 'drs', 'eng', 'enga', 'engas',
    'engos', 'ex', 'exo', 'exmo', 'fig', 'op', 'prof', 'sr', 'sra', 'sras', 'srs', 'sto',
    'v', 'vs', 'i.e', 'rev', 'e.g', 'Nos', 'Nr',
    ]),
    numericOnly: new Set<string>([
    'No', 'Art', 'p', 'pp',
    ]),
});

/**
 * A word, a period, whitespace, optional opening punctuation, then the first
 * character that decides. The lookahead does not consume, so consecutive
 * abbreviations each match. `\p{L}` and the `u` flag make the word class
 * Unicode-aware: `Exmo.` is a word. A word may carry interior periods (`i.e`,
 * `e.g` are list entries), as in the Moses splitter this mirrors; without that
 * the two entries were dead.
 *
 * Opening quotes and brackets are skipped before the deciding character, in
 * the spirit of Moses (which lists a fixed set of ASCII quotes and brackets
 * plus `\p{Pi}`; this class is the wider `\p{Ps}`, so brackets of every
 * script count): `Dr. "Silva"` and `Dr. (Silva)` are the same sentence as
 * `Dr. Silva`, and the segmenter cuts all three the same way (measured on
 * Node 24). Without the skip the quote is what gets tested, it is neither
 * upper-case nor a digit, and the period goes unprotected.
 */
const CANDIDATE = /(?<![\p{L}\p{N}.])([\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)*)\.(?=\s+[\p{Pi}\p{Ps}"'¿¡]*(\S))/gu;

/**
 * Masks the period after every listed abbreviation, when what follows makes
 * the period look like a sentence end. Same contract as `maskFormulas`:
 * `countCodePoints(text) === countCodePoints(result.text)`, spans in order.
 * Each span is exactly one code point: the period.
 */
export function maskAbbreviationPeriods(text: string, list: AbbreviationList = PT_BR_ABBREVIATIONS): MaskResult {
    const spans: Span[] = [];
    CANDIDATE.lastIndex = 0;
    for (const m of text.matchAll(CANDIDATE)) {
        const word = m[1]!;
        const next = m[2]!;
        const isDigit = /\p{Nd}/u.test(next);
        const isUpper = /\p{Lu}/u.test(next);
        // `numericOnly` is consulted FIRST so that a word in both classes
        // (`Art`, `p` in the pt list) follows the stricter rule. That is what
        // the source means: the Moses loader keys a hash by word and the
        // `#NUMERIC_ONLY#` lines come last in the file, so the last assignment
        // wins there. Inferred from the file order and the loader's shape, not
        // measured by running Moses.
        const protect = list.numericOnly.has(word)
            ? isDigit
            : list.always.has(word) && (isUpper || isDigit);
        if (!protect) continue;
        const periodUtf16 = m.index + word.length;
        const start = countCodePoints(text.slice(0, periodUtf16));
        spans.push({ start, end: start + 1 });
    }
    if (spans.length === 0) return { text, spans: [] };
    const points = Array.from(text);
    for (const { start } of spans) points[start] = MASK_CHAR;
    return { text: points.join(''), spans };
}
