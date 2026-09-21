/**
 * Cuts a document into chunks that know exactly where they came from.
 *
 * A chunk is the unit of retrieval and the unit of citation. It has to be
 * small enough to read in a citation card without scrolling — two or three
 * short paragraphs — and it has to carry the exact stretch of the source it
 * covers, so a citation can point at the character and not at the page.
 *
 * Boundaries fall on sentence ends, never inside a sentence, and never inside
 * a formula, a code span, a URL, or right after an abbreviation: those regions
 * are masked before the segmenter sees the text (see `mask.ts`), and the mask
 * is length-preserving, so every position the segmenter reports on the masked
 * text is a valid position on the original. `Chunk.text` is always cut from
 * the ORIGINAL — a chunk never carries a mask character.
 */

import type { Span } from './types.js';
import { countCodePoints, sliceByCodePoints } from './unicode.js';
import { defaultSegmenter, sentencesOf } from './sentences.js';
import type { Segmenter, Sentence } from './sentences.js';
import type { AbbreviationList } from './abbreviations.js';

/**
 * A page already rasterized by the caller, ready to be embedded as-is.
 *
 * Both fields are what the provider's request needs and nothing more. The
 * `mimeType` is required because providers reject a request without it, and
 * it is NOT checked against the bytes: checking would mean parsing an image
 * header, and this package opens no binary. A lying `mimeType` is therefore
 * undetectable here — measured against one provider, it also does not change
 * the vector, because the bytes are what gets decoded.
 */
export interface PageImage {
    /** The image, base64-encoded. */
    readonly data: string;
    /** For example `image/jpeg`. Declared by the caller, never verified here. */
    readonly mimeType: string;
}

/**
 * A document as the core receives it: text already extracted. The core opens
 * no binary — a PDF, a web page or a subtitle file is somebody else's job to
 * turn into this.
 */
export interface SourceDoc {
    readonly id: string;
    readonly text: string;
    /**
     * Present when the text came from a paged source. Absent for pasted text.
     * Read by `maxChunksPerPage` in the index builder, which is the only reason
     * this field survives while `title`, `sourceUri` and `metadata` did not:
     * those three had no reader in `src/` at all.
     */
    readonly pageNumber?: number;
    /**
     * The rasterized page, for a page whose text could not be extracted.
     *
     * Supplying this ALONGSIDE usable text is refused, not merged. The two
     * together would describe a page eligible for both arms through different
     * fields, and the fused ranking has no rule for that — a chunk absent
     * from the lexical list is scored as ranked below every chunk present in
     * it, which is right while absence means "the terms did not match" and
     * wrong when it means "this could never have matched". Refusing keeps the
     * one case the ranking cannot express out of the index entirely, rather
     * than letting it in and ranking it by a rule that does not fit.
     *
     * The caller decides what "usable" means; this package only checks that
     * the two are not both present.
     */
    readonly page?: PageImage;
}

/**
 * True when the document carries a rasterized page.
 *
 * Says nothing about the text on its own — `chunk` refuses a document that
 * carries a page alongside text, so INSIDE the builder this also means the
 * document has no text to index. A caller that reaches for this directly
 * has no such gate, and gets the question the name asks.
 */
export function isImageOnly(doc: SourceDoc): boolean {
    return doc.page !== undefined;
}

/**
 * Refuses a document that carries a page image and usable text at once.
 *
 * Called from `chunk`, which every path into the index goes through, so a
 * caller cannot reach the builder around it.
 */
function assertNotBothArms(doc: SourceDoc): void {
    if (doc.page !== undefined && doc.text.trim() !== '') {
        throw new Error(
            `SourceDoc ${doc.id} carries both a page image and text ` +
                `(${[...doc.text.trim()].length} code points). Supply one: the page image is for ` +
                `a page whose text could not be extracted. See SourceDoc.page.`,
        );
    }
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

export interface ChunkOptions {
    /**
     * Ceiling for the interval a chunk covers, whitespace between sentences
     * included. A single sentence longer than this is never split: it becomes
     * a chunk on its own, over the ceiling, because cutting inside a sentence
     * produces a citation that starts or ends mid-thought.
     */
    readonly maxChunkCodePoints: number;
    /**
     * How much of the previous chunk's tail is repeated at the start of the
     * next, in whole sentences, up to this many code points. Overlap keeps a
     * fact that straddles a boundary findable from both sides.
     */
    readonly maxOverlapCodePoints: number;
    readonly segmenter?: Segmenter;
    /** Abbreviations whose period must not end a sentence. Default: the pt-BR list. */
    readonly abbreviations?: AbbreviationList;
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
    assertNotBothArms(doc);

    // A page with no text has no sentences, so the loop below would return
    // nothing and the page would be absent from the index with no error. One
    // chunk stands for the whole sheet: the unit of retrieval for a scanned
    // page is the page, because there is nothing smaller to point at.
    //
    // `text` is empty and stays empty. Putting a placeholder in it would put
    // that placeholder in the lexical index, where it would match queries
    // that have nothing to do with the page.
    if (isImageOnly(doc)) {
        const base = { id: `${doc.id}#0`, documentId: doc.id, text: '', span: { start: 0, end: 0 } };
        return [doc.pageNumber === undefined ? base : { ...base, pageNumber: doc.pageNumber }];
    }

    const sentences = sentencesOf(doc.text, opts.segmenter ?? defaultSegmenter(), opts.abbreviations);
    const chunks: Chunk[] = [];
    let i = 0;
    while (i < sentences.length) {
        // Grow the chunk forward, sentence by sentence, while it fits.
        //
        // The budget measures the span that will be EMITTED, not the sum of
        // the sentence lengths. Those two differ: a sentence span is trimmed,
        // so the whitespace between two sentences belongs to neither, while
        // the chunk is cut as one continuous interval and carries it. Summing
        // lengths let a chunk pass the check and then be emitted over the
        // ceiling by exactly that whitespace. Measuring the interval removes
        // the second quantity that could drift from the first.
        const first = sentences[i]!;
        let last = i;
        while (
            last + 1 < sentences.length &&
            sentences[last + 1]!.end - first.start <= opts.maxChunkCodePoints
        ) {
            last++;
        }

        const span: Span = { start: first.start, end: sentences[last]!.end };
        chunks.push(toChunk(doc, chunks.length, span));

        if (last + 1 >= sentences.length) break;

        // Overlap: step back over whole sentences from the end of this chunk
        // while they fit in the overlap budget, so the next chunk begins
        // inside this one's tail. Never step back to (or past) where this
        // chunk began, or the loop would not advance.
        //
        // Measured as an interval for the same reason as the chunk budget
        // above: the repeated text runs from the sentence stepped back to
        // where this chunk ends, whitespace included.
        //
        // The second condition is what keeps the next chunk from being pure
        // repetition. Stepping back costs room, and the next sentence is the
        // only content the next chunk is guaranteed to add; step back so far
        // that it no longer fits and the next chunk is emitted holding
        // nothing but text already in this one. Measured on the corpus before
        // this guard: three such chunks, one of them the eight code points of
        // "Art. 12." alone, separated from the article it numbers — findable
        // by a search that then shows the reader nothing.
        //
        // Stopping the step-back is the whole fix. No content is lost: what
        // the overlap would have repeated is, by definition, already in this
        // chunk.
        let next = last + 1;
        while (
            next - 1 > i &&
            sentences[last]!.end - sentences[next - 1]!.start <= opts.maxOverlapCodePoints &&
            sentences[last + 1]!.end - sentences[next - 1]!.start <= opts.maxChunkCodePoints
        ) {
            next--;
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
