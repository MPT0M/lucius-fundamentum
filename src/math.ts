/**
 * Formula protection for text that is about to be cut into sentences.
 *
 * A sentence segmenter sees `$x = 1.5$` and stops at the `.` — the cut lands
 * inside the formula, the citation chip is born in the middle of a LaTeX
 * command, and the renderer breaks on screen. This module hides every formula
 * from whatever decides where a sentence ends, without moving a single
 * position.
 *
 * LENGTH-PRESERVING BY CONSTRUCTION. Each formula is replaced by a run of the
 * same number of code points, so `countCodePoints(masked) === countCodePoints(text)`
 * and every span computed against the masked text is valid against the
 * original, with no translation table. The alternative — lift the formula out
 * and reinsert it later — needs coordinate arithmetic on every consumer, and
 * coordinate arithmetic is the class of defect this package exists to remove.
 *
 * The mask character is U+E000, from the Private Use Area. Three reasons, each
 * sufficient on its own:
 *   - no normalization form touches it, so NFC or NFKC downstream cannot
 *     dissolve the mask;
 *   - it is NOT whitespace, so `trim()`, `split(/\s+/)`, whitespace collapse
 *     and word segmenters — things a consumer does without thinking — leave the
 *     length exactly alone;
 *   - it is a single code point and never half of a surrogate pair.
 * A space fails the second: a masked formula at the edge of a string would be
 * trimmed away, a word counter would count it as a gap, and the length
 * invariant this module exists for would hold only until the first `.trim()`.
 * A no-break space fails the first: NFKC folds U+00A0 to U+0020 — and it also
 * occurs legitimately in Brazilian typography (`R$ 2.000,00`, `art. 5º`).
 *
 * The identity of what was masked travels in the RETURN VALUE, as spans — not
 * in the character. Callers that need the formula text slice the original with
 * the span; nothing is ever restored, because nothing was removed.
 */

import type { Span } from './types.js';
import { countCodePoints } from './unicode.js';

/** U+E000: first code point of the Private Use Area. See the module comment. */
export const MASK_CHAR = '';

/**
 * Display formula: `$$ ... $$`, possibly spanning lines. Matched first so its
 * two dollars are never read as an inline opener plus an inline closer.
 */
const BLOCK = /\$\$[\s\S]+?\$\$/g;

/**
 * Inline formula: `$ ... $` with two guards that are independent and both
 * necessary.
 *
 * The first guard — no whitespace adjacent to either delimiter — is what keeps
 * a price from opening a formula: in `De $100 a $200 reais` the second dollar
 * is preceded by a space, so nothing matches.
 *
 * The second guard — neither delimiter may be escaped — is what keeps an
 * escaped price from CLOSING one: in `$100 dolares e \$200`, the `\$` is not a
 * closer, so the run from `$100` finds no end and nothing matches.
 *
 * A version with only the first guard matched `$100 dolares e \$`. A version
 * with only the second matched `$50 reais e vale $` in `Custa $50 reais e vale
 * $x^2$ pontos` — masking the price and leaving the real formula exposed, which
 * is worse than masking nothing. Both guards, or neither is worth having.
 */
const INLINE = /(?<!\\)\$([^\s$](?:[^$]*?[^\s$])?)(?<!\\)\$/g;

export interface MaskResult {
    /** Same number of code points as the input. */
    readonly text: string;
    /** Where each formula lives in the ORIGINAL text, delimiters included, in order. */
    readonly spans: readonly Span[];
}

/**
 * Replaces every formula in `text` with a run of `MASK_CHAR` of identical
 * code point length, and reports where the formulas were.
 *
 * Spans are in code points into `text` and include the `$` delimiters: the
 * delimiter is what a segmenter would trip on, so it is part of what must be
 * hidden.
 */
export function maskFormulas(text: string): MaskResult {
    const regions: Span[] = [];
    collect(text, BLOCK, regions);
    collect(text, INLINE, regions, regions);
    regions.sort((a, b) => a.start - b.start);

    if (regions.length === 0) return { text, spans: [] };

    const points = Array.from(text);
    for (const { start, end } of regions) {
        for (let i = start; i < end; i++) points[i] = MASK_CHAR;
    }
    return { text: points.join(''), spans: regions };
}

/**
 * Appends every match of `re` in `text` as a code point span. Matches that
 * overlap an already-collected region are skipped — an inline `$` inside a
 * block formula belongs to the block.
 */
function collect(text: string, re: RegExp, out: Span[], skipInside: readonly Span[] = []): void {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
        const utf16Start = m.index;
        const utf16End = utf16Start + m[0].length;
        const start = countCodePoints(text.slice(0, utf16Start));
        const end = start + countCodePoints(m[0]);
        if (skipInside.some((r) => start < r.end && end > r.start)) continue;
        out.push({ start, end });
    }
}
