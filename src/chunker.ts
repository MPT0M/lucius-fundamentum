/**
 * Cuts a document into chunks that know exactly where they came from.
 *
 * A chunk is the unit of retrieval and the unit of citation. It has to be
 * small enough to read in a citation card without scrolling — two or three
 * short paragraphs — and it has to carry the exact stretch of the source it
 * covers, so a citation can point at the character and not at the page.
 *
 * Boundaries fall on sentence ends, never inside a sentence, and never inside
 * a formula: formulas are masked before the segmenter sees the text, and the
 * mask is length-preserving, so every position the segmenter reports on the
 * masked text is a valid position on the original. `Chunk.text` is always cut
 * from the ORIGINAL — a chunk never carries a mask character.
 */

import type { Span } from './types.js';
import { countCodePoints, sliceByCodePoints } from './unicode.js';
import { maskProtectedRegions } from './mask.js';

/**
 * A document as the core receives it: text already extracted. The core opens
 * no binary — a PDF, a web page or a subtitle file is somebody else's job to
 * turn into this.
 */
export interface SourceDoc {
    readonly id: string;
    readonly title: string;
    readonly text: string;
    /** Present when the text came from a paged source. Absent for pasted text. */
    readonly pageNumber?: number;
    readonly sourceUri?: string;
    readonly metadata?: Readonly<Record<string, string | number>>;
}

/**
 * A rectangle on a page, normalized to `0..1` of the page's width and height,
 * origin at the top-left. Reserved for paged sources; the chunker of pasted
 * text never fills it. Defined now so that adding it later is not a format
 * change that invalidates every existing index.
 */
export interface BoundingBox {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface Chunk {
    /** `${documentId}#${ordinal}` — stable for a given document and options. */
    readonly id: string;
    readonly documentId: string;
    /** Cut from the raw source text. Never contains a mask character. */
    readonly text: string;
    /** Where `text` lives in the source, in code points. */
    readonly span: Span;
    readonly pageNumber?: number;
    /** One box per line, when the source is paged. Absent for pasted text. */
    readonly boxes?: readonly BoundingBox[];
}

/**
 * Anything with the shape of `Intl.Segmenter`: given a string, yields the
 * segments with their UTF-16 start index. Injectable so the library does not
 * hard-wire a runtime API — `Intl.Segmenter` is the default where it exists,
 * and a caller on a runtime without it supplies its own.
 */
export interface Segmenter {
    segment(text: string): Iterable<{ readonly index: number; readonly segment: string }>;
}

export interface ChunkOptions {
    /** Target size. A single sentence longer than this becomes a chunk on its own. */
    readonly maxChunkCodePoints: number;
    /**
     * How much of the previous chunk's tail is repeated at the start of the
     * next, in whole sentences, up to this many code points. Overlap keeps a
     * fact that straddles a boundary findable from both sides.
     */
    readonly maxOverlapCodePoints: number;
    readonly segmenter?: Segmenter;
}

/**
 * The library does not know how to count tokens — that needs the provider's
 * tokenizer or a network call, and the core has no dependencies. The owner's
 * decision was 250–350 tokens with 30–50 of overlap; at the declared 3–4
 * characters per token for Portuguese, that is this. The factor is a documented
 * approximation, not a measurement, and the measurement harness will calibrate it.
 */
export const DEFAULT_CHUNK_OPTIONS: Readonly<Omit<ChunkOptions, 'segmenter'>> = {
    maxChunkCodePoints: 1200,
    maxOverlapCodePoints: 160,
};

function defaultSegmenter(): Segmenter {
    return new Intl.Segmenter('pt-BR', { granularity: 'sentence' });
}

/** A sentence as a code point span into the source. */
interface Sentence {
    readonly start: number;
    readonly end: number;
    readonly length: number;
}

/**
 * Sentence spans of `text`, in code points, computed on the MASKED text so no
 * boundary can land inside a formula. Because the mask preserves length, the
 * spans are valid on the original.
 */
function sentencesOf(text: string, segmenter: Segmenter): Sentence[] {
    const masked = maskProtectedRegions(text).text;
    const out: Sentence[] = [];
    let utf16Cursor = 0;
    let cpCursor = 0;
    for (const { index, segment } of segmenter.segment(masked)) {
        // Segments come in order and are contiguous; advance the code point
        // cursor by the code points between the last segment and this one
        // (normally zero) rather than recounting from the start each time.
        cpCursor += countCodePoints(masked.slice(utf16Cursor, index));
        const trimmed = trimmedSpan(segment, cpCursor);
        if (trimmed) out.push(trimmed);
        utf16Cursor = index + segment.length;
        cpCursor += countCodePoints(segment);
    }
    return out;
}

/**
 * The segmenter hands back each sentence WITH the whitespace that follows it
 * — the space after the period, the newline after the paragraph. A citation
 * that ends in a trailing space is sloppy, and the space would count against
 * the chunk budget. So the span is tightened to the first and last non-space
 * code point. The mask character is not whitespace, so a sentence that is
 * nothing but a formula keeps its full extent.
 *
 * Returns `null` for a segment that is whitespace only.
 */
function trimmedSpan(segment: string, start: number): Sentence | null {
    const points = Array.from(segment);
    let a = 0;
    let b = points.length;
    while (a < b && /\s/u.test(points[a]!)) a++;
    while (b > a && /\s/u.test(points[b - 1]!)) b--;
    if (a === b) return null;
    return { start: start + a, end: start + b, length: b - a };
}

/**
 * Cuts `doc.text` into chunks of at most `maxChunkCodePoints`, on sentence
 * boundaries, with a sentence-aligned overlap of up to `maxOverlapCodePoints`.
 *
 * A sentence longer than the maximum is never split: it becomes a chunk on
 * its own, oversized, because cutting inside a sentence would produce a
 * citation that starts or ends mid-thought — which is worse than a long card.
 */
export function chunk(doc: SourceDoc, opts: ChunkOptions): readonly Chunk[] {
    if (opts.maxChunkCodePoints <= 0) {
        throw new RangeError(`maxChunkCodePoints must be positive, got ${opts.maxChunkCodePoints}`);
    }
    if (opts.maxOverlapCodePoints < 0 || opts.maxOverlapCodePoints >= opts.maxChunkCodePoints) {
        throw new RangeError(
            `maxOverlapCodePoints must be in [0, maxChunkCodePoints), got ${opts.maxOverlapCodePoints}`,
        );
    }

    const sentences = sentencesOf(doc.text, opts.segmenter ?? defaultSegmenter());
    const chunks: Chunk[] = [];
    let i = 0;
    while (i < sentences.length) {
        // Grow the chunk forward, sentence by sentence, while it fits.
        const first = sentences[i]!;
        let last = i;
        let size = first.length;
        while (last + 1 < sentences.length && size + sentences[last + 1]!.length <= opts.maxChunkCodePoints) {
            last++;
            size += sentences[last]!.length;
        }

        const span: Span = { start: first.start, end: sentences[last]!.end };
        chunks.push(toChunk(doc, chunks.length, span));

        if (last + 1 >= sentences.length) break;

        // Overlap: step back over whole sentences from the end of this chunk
        // while they fit in the overlap budget, so the next chunk begins
        // inside this one's tail. Never step back to (or past) where this
        // chunk began, or the loop would not advance.
        let next = last + 1;
        let overlap = 0;
        while (next - 1 > i && overlap + sentences[next - 1]!.length <= opts.maxOverlapCodePoints) {
            next--;
            overlap += sentences[next]!.length;
        }
        i = next;
    }
    return chunks;
}

function toChunk(doc: SourceDoc, ordinal: number, span: Span): Chunk {
    const base = {
        id: `${doc.id}#${ordinal}`,
        documentId: doc.id,
        text: sliceByCodePoints(doc.text, span.start, span.end),
        span,
    };
    return doc.pageNumber === undefined ? base : { ...base, pageNumber: doc.pageNumber };
}
