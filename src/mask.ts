/**
 * Every region a sentence cut must not enter: formulas, code, URLs, and the
 * period after an abbreviation.
 *
 * `math.ts` protects formulas. This module applies the same rule — replace the
 * region with a run of the mask character of identical code point length,
 * return the spans — to the three other kinds of text that carry sentence-like
 * punctuation inside them and mean something different if cut:
 *
 *   - code, fenced or inline: `obj.method()` has a period a segmenter will
 *     read as a sentence end, and a chunk boundary inside a code block yields
 *     two half-blocks that neither render nor index as code;
 *   - URLs: `https://example.com/a.b` is one token to a reader and three
 *     sentences to a naive segmenter;
 *   - the period after an abbreviation: `Dr. Silva` is one name, and the
 *     period alone is masked (see `abbreviations.ts`).
 *
 * ORDER MATTERS, and this is why the module composes rather than reuses the
 * formula patterns directly. Code is the outermost container: `$x$` inside a
 * fenced block is code, not a formula. So code and URLs are masked FIRST, on
 * the raw text, and only then is `maskFormulas` run — on text where any `$`
 * inside code has already become a mask character and cannot match. Running
 * formulas first would claim a span inside the code block, and the block's own
 * span would then be skipped as overlapping. Abbreviations come FOURTH and
 * last, for the same reason one step further: `Dr.` inside a code block is
 * code and the period of `example.com` is a URL's, and by then both are mask
 * characters that no word pattern can match.
 *
 * Length is preserved at every step, so all spans are valid against the
 * original, and `Chunk.text` is still cut from the original — a chunk never
 * carries a mask character.
 */

import type { Span } from './types.js';
import { matchSpans } from './unicode.js';
import { MASK_CHAR, maskFormulas, type MaskResult } from './math.js';
import { maskAbbreviationPeriods, type AbbreviationList } from './abbreviations.js';

/** Triple-backtick fence, possibly spanning lines. Matched before inline code. */
const FENCED_CODE = /```[\s\S]*?```/g;

/** Single-backtick span on one line. A backtick pair across lines is not code. */
const INLINE_CODE = /`[^`\n]+`/g;

/**
 * `http(s)://` up to the first whitespace or common closing delimiter. The
 * trailing-punctuation problem (`https://x.y.` at a sentence end) is resolved
 * by trimming: a URL does not end in `.`, `,`, `;` or `:`.
 *
 * KNOWN LIMITATION: `$` and the backtick are accepted inside a URL, so a URL
 * glued to a formula or code delimiter (`https://x.y$a$`) swallows the
 * delimiter, and the region is reported as `url` over what was a formula.
 * Declared in 5411978; kept visible by an `it.fails` in the tests. Changing it
 * changes masking behaviour and is a separate decision.
 */
const URL = /https?:\/\/[^\s<>"'\])]+/g;
const URL_TRAILING = /[.,;:!?]+$/u;

/** Options of `maskProtectedRegions`; every field has a default. */
export interface MaskOptions {
    /** Abbreviations whose period is hidden from the segmenter. Default: pt-BR list. */
    readonly abbreviations?: AbbreviationList;
}

/**
 * The kind of region a span was painted by. One value per pass of
 * `maskProtectedRegions`, in the order the passes run.
 */
export type ProtectedRegionKind = 'code' | 'url' | 'formula' | 'abbreviation';

/**
 * A protected span that says which pass painted it. Structurally a `Span` — a
 * reader of `start`/`end` sees no difference — so a `ClassifiedMaskResult` is
 * assignable wherever a `MaskResult` is expected.
 */
export type ProtectedSpan = Span & { readonly kind: ProtectedRegionKind };

/**
 * `MaskResult` whose spans carry their kind. Narrower than `MaskResult`, never
 * wider: the only thing added is `kind`. It exists because a consumer that
 * measures HOW MUCH of an interval falls inside code, inside a URL, inside a
 * formula or on an abbreviation period cannot do so from an anonymous list of
 * spans — and the passes already know, so the information is free to report.
 */
export interface ClassifiedMaskResult extends MaskResult {
    readonly spans: readonly ProtectedSpan[];
}

/**
 * Masks code and URLs first, then formulas, then abbreviation periods, and
 * reports every region with the kind of the pass that painted it. Same
 * contract as `maskFormulas`: `countCodePoints(text) === countCodePoints(result.text)`,
 * spans in order, non-overlapping, delimiters included (for an abbreviation
 * the region is the period alone).
 */
export function maskProtectedRegions(text: string, opts: MaskOptions = {}): ClassifiedMaskResult {
    const regions: ProtectedSpan[] = [];
    let masked = text;

    for (const re of [FENCED_CODE, INLINE_CODE]) {
        const spans = matchSpans(masked, re).filter((s) => !overlapsAny(s, regions));
        regions.push(...withKind(spans, 'code'));
        masked = paint(masked, spans);
    }

    const urls = matchSpans(masked, URL)
        .map((s) => trimTrailingPunctuation(masked, s))
        .filter((s) => !overlapsAny(s, regions));
    regions.push(...withKind(urls, 'url'));
    masked = paint(masked, urls);

    const formulas = maskFormulas(masked);
    regions.push(...withKind(formulas.spans, 'formula'));
    masked = formulas.text;

    // Abbreviations go LAST, on text where code, URLs and formulas are already
    // mask characters: a `Dr.` inside a code block is code, and the period of
    // `example.com` is a URL's, not an abbreviation's. Only the period is
    // masked, one code point, so the word itself stays indexable.
    const abbreviations = maskAbbreviationPeriods(masked, opts.abbreviations);
    regions.push(...withKind(abbreviations.spans, 'abbreviation'));

    regions.sort((a, b) => a.start - b.start);
    return { text: abbreviations.text, spans: regions };
}

function withKind(spans: readonly Span[], kind: ProtectedRegionKind): ProtectedSpan[] {
    return spans.map(({ start, end }) => ({ start, end, kind }));
}

function overlapsAny(s: Span, others: readonly Span[]): boolean {
    return others.some((r) => s.start < r.end && s.end > r.start);
}

/** Replaces the code points inside each span with the mask character. */
function paint(text: string, spans: readonly Span[]): string {
    if (spans.length === 0) return text;
    const points = Array.from(text);
    for (const { start, end } of spans) {
        for (let i = start; i < end; i++) points[i] = MASK_CHAR;
    }
    return points.join('');
}

/** Pulls the span's end back over sentence punctuation that is not part of the URL. */
function trimTrailingPunctuation(text: string, s: Span): Span {
    const slice = Array.from(text).slice(s.start, s.end).join('');
    const trimmed = slice.replace(URL_TRAILING, '');
    return { start: s.start, end: s.start + Array.from(trimmed).length };
}
