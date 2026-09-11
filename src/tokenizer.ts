/**
 * Turns text into the terms an index is built from, and keeps every term
 * pointing at the exact stretch of the ORIGINAL that produced it.
 *
 * The span is the whole reason this file is not three lines of `split`. A term
 * is normalized — lower case, accents folded, plural stripped — and none of
 * that text exists in the document. Without a span back to the raw source, a
 * hit can be scored but never shown: the citation would have to re-find the
 * word by searching for a string the page does not contain.
 *
 * So the order is: segment the RAW text, fix each span there, and only then
 * normalize a copy of the slice. Normalizing first would be simpler and would
 * be wrong — NFC changes length, so every span measured on normalized text
 * drifts from the original by however many characters were composed before it
 * (`unicode.ts`, `normalizeUnicode`).
 */

import type { Span } from './types.js';
import { normalizeUnicode } from './unicode.js';
import { maskProtectedRegions, type ProtectedSpan } from './mask.js';
import type { AbbreviationList } from './abbreviations.js';

/** A term as it enters the index, and where it came from. */
export interface Token {
    /** Normalized: lower case, accents folded, stemmed if a stemmer is present. */
    readonly term: string;
    /** Code points in the RAW text that produced `term`. */
    readonly span: Span;
}

/**
 * Reduces a term to its stem. Pure and total: same input, same output, no
 * throwing, no network. Receives the term already folded, so a third-party
 * stemmer does not repeat the folding.
 */
export interface Stemmer {
    readonly id: string;
    stem(term: string): string;
}

export interface Tokenizer {
    /**
     * Recorded in the index artifact. Attributing with a tokenizer whose id
     * differs from the one that indexed is an error at the call, not a silent
     * mismatch — the same protection `providerId` gives the vector space.
     */
    readonly id: string;
    /**
     * `protectedSpans` is an OPTIMIZATION, not a mode. Left out, the tokenizer
     * calls `maskProtectedRegions` itself and produces the same terms — as
     * long as no protected region crosses the boundary of `text`. When one
     * does, the caller that passes the document's spans is the one that gets
     * it right, because half of a fenced block has no fence and half of a URL
     * has no scheme. That divergence is pinned by a test rather than left to
     * be discovered.
     */
    tokenize(text: string, protectedSpans?: readonly ProtectedSpan[]): readonly Token[];
}

/**
 * Anything shaped like `Intl.Segmenter` with `granularity: 'word'`. Injectable
 * so the package does not hard-wire a runtime API, and so the fallback path
 * can be exercised on a runtime that does have `Intl`.
 */
export interface WordSegmenter {
    segment(text: string): Iterable<{
        readonly index: number;
        readonly segment: string;
        readonly isWordLike?: boolean;
    }>;
}

export interface TokenizerOptions {
    /**
     * Left out, `Intl.Segmenter` is used where the runtime has it. Pass
     * `null` to force the Unicode-class path: the fallback is the code that
     * runs on the runtimes we cannot test on, so it has to be reachable from
     * the ones we can.
     */
    readonly segmenter?: WordSegmenter | null;
    readonly stemmer?: Stemmer;
    readonly abbreviations?: AbbreviationList;
}

/**
 * The kinds whose region is a single token. `abbreviation` is deliberately
 * absent: its protected region is the period alone (`mask.ts`), so treating it
 * as an atom would emit a term of `"."` in every posting list in the corpus.
 */
const ATOM_KINDS: ReadonlySet<ProtectedSpan['kind']> = new Set(['code', 'url', 'formula']);

/**
 * Separators that do not break a token when digits sit on both sides.
 *
 * Two of the five come from UAX #29 and three are an extension of ours. `.` is
 * MidNumLet and `,` is MidNum, so WB11/WB12 already join `8.078` and
 * `2.000,00`. `/`, `-` and `:` are in none of those classes — measured, the
 * standard breaks `8.078/90`, `2026-09-09` and `12:30` — and they are here
 * because Brazilian legal references, ISO dates and clock times are worth
 * keeping whole in a lexical index.
 *
 * The set is deliberately not widened to every separator the standard joins.
 * `;` (MidNum), `⁄` (U+2044) and `٫` (U+066B) join digits under UAX #29 and are
 * NOT here, because none of them appears in the forms above and symmetry with
 * a standard this rule already extends is not a reason. The consequence is a
 * declared divergence between the two segmentation paths, pinned by a test.
 */
const DIGIT_SEPARATORS: ReadonlySet<string> = new Set(['.', ',', '/', ':', '-']);

const DIGIT = /\p{Nd}/u;
/** Letters, digits and combining marks: what the fallback path counts as a word. */
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const COMBINING_MARK = /\p{M}/gu;

function defaultSegmenter(): WordSegmenter | null {
    return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter('pt-BR', { granularity: 'word' })
        : null;
}

/** A candidate token as a code point range, before normalization. */
interface Range {
    start: number;
    end: number;
    /** A protected region that must not be extended or split. */
    atom: boolean;
}

/**
 * Pass 1, `Intl` path: the segmenter proposes the boundaries and we keep the
 * word-like segments. Indices arrive in UTF-16, so a cursor walks them into
 * code points rather than re-counting from the start for each segment.
 */
function segmentWithIntl(text: string, segmenter: WordSegmenter): Range[] {
    const out: Range[] = [];
    let utf16Cursor = 0;
    let cpCursor = 0;
    for (const { index, segment, isWordLike } of segmenter.segment(text)) {
        // Segments are normally contiguous, so this slice is normally empty;
        // skipping it avoids an allocation per segment over a long document.
        if (index > utf16Cursor) cpCursor += Array.from(text.slice(utf16Cursor, index)).length;
        const length = Array.from(segment).length;
        if (isWordLike) out.push({ start: cpCursor, end: cpCursor + length, atom: false });
        utf16Cursor = index + segment.length;
        cpCursor += length;
    }
    return out;
}

/**
 * Pass 1, fallback path: runs of letters, digits and marks. It breaks every
 * separator, including the two the standard would join — pass 3 puts those
 * back, which is what makes the two paths agree on the five separators.
 */
function segmentByClass(points: readonly string[]): Range[] {
    const out: Range[] = [];
    let start = -1;
    for (let i = 0; i < points.length; i += 1) {
        if (WORD_CHAR.test(points[i]!)) {
            if (start < 0) start = i;
        } else if (start >= 0) {
            out.push({ start, end: i, atom: false });
            start = -1;
        }
    }
    if (start >= 0) out.push({ start, end: points.length, atom: false });
    return out;
}

/**
 * Pass 2: a protected region of `code`, `url` or `formula` replaces every
 * range it touches with one atom covering exactly the region. The mask is
 * never applied to the text — the term comes from the RAW slice, because a
 * term made of mask characters would index nothing.
 */
function overlayProtectedRegions(ranges: readonly Range[], spans: readonly ProtectedSpan[]): Range[] {
    const atoms = spans
        .filter((s) => ATOM_KINDS.has(s.kind))
        .slice()
        .sort((a, b) => a.start - b.start);
    if (atoms.length === 0) return ranges.slice();

    const out: Range[] = [];
    for (const range of ranges) {
        if (!atoms.some((a) => range.start < a.end && a.start < range.end)) out.push(range);
    }
    for (const a of atoms) out.push({ start: a.start, end: a.end, atom: true });
    out.sort((x, y) => x.start - y.start);
    return out;
}

/**
 * Pass 3: fuse two adjacent ranges separated by exactly one separator with a
 * digit on each side, so `8.078/90` is one term and not three.
 *
 * Never fuses across the edge of an atom: extending one would make its span
 * differ from the protected region it stands for, which is the contract of
 * pass 2. The period of an abbreviation is not an atom and is not a border
 * here — it is always followed by whitespace (`abbreviations.ts`), so no
 * fusion can reach it anyway.
 */
function fuseCompositeNumbers(ranges: readonly Range[], points: readonly string[]): Range[] {
    const out: Range[] = [];
    for (const range of ranges) {
        const previous = out[out.length - 1];
        const joinable =
            previous !== undefined &&
            !previous.atom &&
            !range.atom &&
            range.start === previous.end + 1 &&
            DIGIT_SEPARATORS.has(points[previous.end]!) &&
            DIGIT.test(points[previous.end - 1]!) &&
            DIGIT.test(points[range.start]!);
        if (joinable) previous.end = range.end;
        else out.push({ ...range });
    }
    return out;
}

/**
 * Lower case, then accents folded by decomposing and dropping the combining
 * marks. NFC first so the input is in one shape whatever the source did, NFC
 * again at the end so the term itself is composed.
 *
 * This is where length is allowed to change, because by now the span is fixed
 * and nothing downstream measures the term against the document.
 */
export function foldForIndex(raw: string): string {
    return normalizeUnicode(raw)
        .toLocaleLowerCase('pt-BR')
        .normalize('NFD')
        .replace(COMBINING_MARK, '')
        .normalize('NFC');
}

/**
 * The default tokenizer.
 *
 * `id` composes the stemmer's, because a stemmer changes which terms exist:
 * an index built with one and a query tokenized with another disagree on
 * `professores` without either side being able to notice.
 */
export function createTokenizer(opts: TokenizerOptions = {}): Tokenizer {
    const { stemmer, abbreviations } = opts;
    const segmenter = opts.segmenter === undefined ? defaultSegmenter() : opts.segmenter;
    const id = `standard+${stemmer?.id ?? 'no-stemmer'}`;

    return {
        id,
        tokenize(text: string, protectedSpans?: readonly ProtectedSpan[]): readonly Token[] {
            if (text.length === 0) return [];
            const points = Array.from(text);
            const spans =
                protectedSpans ??
                maskProtectedRegions(text, abbreviations ? { abbreviations } : {}).spans;

            const segmented = segmenter ? segmentWithIntl(text, segmenter) : segmentByClass(points);
            const overlaid = overlayProtectedRegions(segmented, spans);
            const fused = fuseCompositeNumbers(overlaid, points);

            const tokens: Token[] = [];
            for (const range of fused) {
                const slice = points.slice(range.start, range.end).join('');
                const folded = foldForIndex(slice);
                // An atom is a literal — a URL, a fenced block, a formula —
                // and a stemmer applied to one corrupts it: `.../status`
                // becomes `.../statu`, `docs` becomes `doc`. Worse than ugly,
                // it breaks the invariant this file exists for, because the
                // span still points at the whole region and the term is no
                // longer what that region folds to. Morphology is for words.
                const term = stemmer && !range.atom ? stemmer.stem(folded) : folded;
                if (term.length > 0) tokens.push({ term, span: { start: range.start, end: range.end } });
            }
            return tokens;
        },
    };
}
