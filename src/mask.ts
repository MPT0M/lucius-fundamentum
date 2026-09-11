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
 * One exception to "a later pass cannot match inside an earlier region": a
 * URL stops at `$` and leaves that `$` in the text, and the formula pattern
 * crosses mask characters, so a `$` opened before the URL can close on it.
 * That is why the formula pass, like the code and URL passes, drops a match
 * that overlaps an earlier region and repaints only what it kept.
 *
 * Length is preserved at every step, so all spans are valid against the
 * original, and `Chunk.text` is still cut from the original — a chunk never
 * carries a mask character.
 */

import type { Span } from './types.js';
import { countCodePoints, matchSpans } from './unicode.js';
import { MASK_CHAR, maskFormulas, type MaskResult } from './math.js';
import { maskAbbreviationPeriods, type AbbreviationList } from './abbreviations.js';

/** Triple-backtick fence, possibly spanning lines. Matched before inline code. */
const FENCED_CODE = /```[\s\S]*?```/g;

/** Single-backtick span on one line. A backtick pair across lines is not code. */
const INLINE_CODE = /`[^`\n]+`/g;

/**
 * `http(s)://` up to the first whitespace, common closing delimiter, or the
 * delimiter of another region. The trailing-punctuation problem
 * (`https://x.y.` at a sentence end) is resolved by trimming: a URL does not
 * end in `.`, `,`, `;` or `:`.
 *
 * A URL stops at `$`, at a backtick and at the mask character (U+E000, the
 * `MASK_CHAR` of an already painted code region): a URL glued to a formula
 * (`https://x.y$a$`) or to inline code must not swallow the delimiter and
 * report the formula as `url`, nor cross into painted code and be dropped
 * whole for overlapping it. The price is declared: a `$` anywhere in a URL —
 * path or query string; RFC 3986 allows it — ends the URL there, and what
 * follows is plain text. The backtick is not valid unencoded in a URL, so
 * excluding it costs nothing.
 */
const URL = /https?:\/\/[^\s<>"'\])$`\uE000]+/g;
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

    const maskedPoints = Array.from(masked);
    const urls = matchSpans(masked, URL)
        .map((s) => trimTrailingPunctuation(maskedPoints, s))
        .filter((s) => !overlapsAny(s, regions));
    regions.push(...withKind(urls, 'url'));
    masked = paint(masked, urls);

    // Filtered and repainted like code and URLs, not adopted whole: a URL now
    // releases the `$` at its boundary, and a `$` opened before the URL can
    // pair with it across the painted region. Such a match overlaps the URL and
    // is dropped; its text is not painted, so the mask stays exactly the spans.
    // The price, declared: any formula that CONTAINS an earlier region — a
    // display block with a URL in it, an inline formula around inline code —
    // is dropped too, and its own text is left unprotected.
    const formulas = maskFormulas(masked).spans.filter((s) => !overlapsAny(s, regions));
    regions.push(...withKind(formulas, 'formula'));
    masked = paint(masked, formulas);

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

/**
 * Pulls the span's end back over sentence punctuation that is not part of the
 * URL.
 *
 * Takes the document ALREADY as code points, and that is the whole point.
 * Both `Array.from(text)` and `sliceByCodePoints(text, ...)` walk the entire
 * string to find a code point offset, so calling either once per URL
 * materializes the document once per URL.
 *
 * Measured on a synthetic document of 222k code points carrying 400 links,
 * timing only the slicing step: 692 ms calling `sliceByCodePoints` once per
 * span, 696 ms calling `Array.from` once per span, and 1.9 ms building the
 * array once and slicing it 400 times. The first two numbers being equal is
 * the finding: swapping one helper for the other buys nothing, because the
 * walk is inside both, and that is why this parameter is an array and not a
 * string.
 *
 * The cost grows with document length times link count, which is the shape
 * that empties a Worker's 128 MB rather than merely slowing it down.
 */
function trimTrailingPunctuation(points: readonly string[], s: Span): Span {
    const trimmed = points.slice(s.start, s.end).join('').replace(URL_TRAILING, '');
    return { start: s.start, end: s.start + countCodePoints(trimmed) };
}
