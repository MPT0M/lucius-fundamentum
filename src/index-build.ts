/**
 * Builds a searchable index over documents, and answers queries against it.
 *
 * This is where the pieces meet: the chunker cuts, the tokenizer turns each
 * chunk into terms that remember where they came from, and BM25 scores. The
 * index owns the numbers those pieces disagree about if nobody owns them —
 * `averageLength`, `k1`, `b` — and writes them into the artifact, so a score
 * is reproducible from the artifact alone and not from whoever called.
 *
 * Lexical only. `dense` is `null` in every artifact this file produces, and
 * `search` refuses rather than pretending: the vector half is a later lot,
 * and an index that quietly answered a hybrid query with half a hybrid would
 * be worse than one that says no.
 */

import type { Span } from './types.js';
import {
    chunk,
    DEFAULT_CHUNK_OPTIONS,
    type BoundingBox,
    type Chunk,
    type ChunkOptions,
    type SourceDoc,
} from './chunker.js';
import { maskProtectedRegions, type ProtectedSpan } from './mask.js';
import { createTokenizer, type Tokenizer } from './tokenizer.js';
import { RSLP_S_FOLDED } from './stemmer.js';
import { bm25TermScore, DEFAULT_BM25_PARAMS, type Bm25Params, type CorpusStats } from './bm25.js';

/**
 * The version of the CHUNKING LOGIC, not of its parameters.
 *
 * An artifact records this so that reusing vectors across a reindex can tell
 * whether the boundaries would still fall in the same places. It cannot be
 * derived from `maxChunkCodePoints` and `maxOverlapCodePoints`: the two fixes
 * that opened this lot moved every boundary in every document while leaving
 * both numbers at 1200 and 160. A derived id would have claimed compatibility
 * and reused vectors against chunks that no longer exist.
 *
 * So it is bumped BY HAND, by whoever changes how the chunker cuts, and a
 * test pins the current value to make forgetting loud.
 */
export const CHUNKER_POLICY = 'v2';

export const INDEX_FORMAT_VERSION = 1;

export interface StoredChunk {
    readonly id: string;
    readonly documentId: string;
    readonly text: string;
    readonly span: Span;
    /** Identifies the text for vector reuse across reindexing. */
    readonly contentHash: string;
    readonly pageNumber?: number;
    /**
     * `chunker.ts` defines this now, unfilled, so that adding it later is not
     * a format change invalidating every index. Dropping it here would have
     * made that promise false the first time a paged source filled it.
     */
    readonly boxes?: readonly BoundingBox[];
}

export interface IndexArtifact {
    readonly formatVersion: number;
    /** `${tokenizer.id}` — attributing with another is an error at the call. */
    readonly tokenizerId: string;
    /** See `CHUNKER_POLICY`. */
    readonly chunkerPolicy: string;
    readonly bm25: { readonly k1: number; readonly b: number; readonly averageLength: number };
    readonly chunks: readonly StoredChunk[];
    /** term -> [chunk index, occurrences in that chunk][]. Index, not id: measured 1.97x smaller. */
    readonly postings: Readonly<Record<string, readonly (readonly [number, number])[]>>;
    readonly dense: {
        readonly providerId: string;
        readonly dimensions: number;
        readonly vectors: string;
    } | null;
}

export interface IndexOptions {
    readonly tokenizer?: Tokenizer;
    readonly chunkOptions?: ChunkOptions;
    /** Saturation and length normalization. The index owns them; see `bm25.ts`. */
    readonly k1?: number;
    readonly b?: number;
}

export interface SearchOptions {
    readonly topK?: number;
    /** At most this many results from any one page. Ignored for unpaged sources. */
    readonly maxChunksPerPage?: number;
}

export interface SearchResult {
    readonly chunk: Chunk;
    readonly score: number;
    /** 1-based position in this result list. */
    readonly rank: number;
}

export interface Index {
    readonly tokenizerId: string;
    searchLexical(query: string, opts?: SearchOptions): readonly SearchResult[];
    /** Refuses while the artifact carries no vectors. */
    search(query: string, opts?: SearchOptions): Promise<readonly SearchResult[]>;
    serialize(): IndexArtifact;
}

const DEFAULT_TOP_K = 10;

/**
 * FNV-1a, twice with different offsets, concatenated to 64 bits of hex.
 *
 * Not cryptographic and not meant to be: it answers "is this the same text as
 * before", so that reindexing a document can skip paying for a vector it
 * already has. Two independent 32-bit passes rather than one because a single
 * 32-bit space collides at a few tens of thousands of chunks, and a collision
 * here would reuse a vector belonging to different text — silently.
 */
function contentHash(text: string): string {
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (const point of text) {
        const code = point.codePointAt(0)!;
        a = Math.imul(a ^ code, 0x01000193) >>> 0;
        b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** The document's protected regions, cut to one chunk and moved to its coordinates. */
function spansForChunk(documentSpans: readonly ProtectedSpan[], span: Span): ProtectedSpan[] {
    const out: ProtectedSpan[] = [];
    for (const region of documentSpans) {
        if (region.end <= span.start || span.end <= region.start) continue;
        out.push({
            kind: region.kind,
            start: Math.max(region.start, span.start) - span.start,
            end: Math.min(region.end, span.end) - span.start,
        });
    }
    return out;
}

interface Built {
    readonly chunks: readonly Chunk[];
    readonly stored: readonly StoredChunk[];
    readonly postings: Map<string, [number, number][]>;
    readonly lengths: number[];
    readonly averageLength: number;
}

function build(docs: readonly SourceDoc[], tokenizer: Tokenizer, chunkOptions: ChunkOptions): Built {
    const chunks: Chunk[] = [];
    const stored: StoredChunk[] = [];
    const postings = new Map<string, [number, number][]>();
    const lengths: number[] = [];
    let totalTokens = 0;

    for (const doc of docs) {
        // The mask runs ONCE over the document. A chunk holding half a fenced
        // block has no closing fence, so regions computed from the chunk alone
        // would miss it; the caller that knows the document is the one that
        // gets this right, which is why the tokenizer takes spans at all.
        const documentSpans = maskProtectedRegions(doc.text).spans;
        for (const piece of chunk(doc, chunkOptions)) {
            const index = chunks.length;
            chunks.push(piece);
            stored.push({
                id: piece.id,
                documentId: piece.documentId,
                text: piece.text,
                span: piece.span,
                contentHash: contentHash(piece.text),
                ...(piece.pageNumber === undefined ? {} : { pageNumber: piece.pageNumber }),
                ...(piece.boxes === undefined ? {} : { boxes: piece.boxes }),
            });

            const counts = new Map<string, number>();
            for (const token of tokenizer.tokenize(piece.text, spansForChunk(documentSpans, piece.span))) {
                counts.set(token.term, (counts.get(token.term) ?? 0) + 1);
            }
            let length = 0;
            for (const [term, times] of counts) {
                let list = postings.get(term);
                if (list === undefined) postings.set(term, (list = []));
                list.push([index, times]);
                length += times;
            }
            lengths.push(length);
            totalTokens += length;
        }
    }

    return {
        chunks,
        stored,
        postings,
        lengths,
        averageLength: chunks.length === 0 ? 0 : totalTokens / chunks.length,
    };
}

function makeIndex(
    built: Built,
    tokenizer: Tokenizer,
    params: Bm25Params,
    dense: IndexArtifact['dense'],
    // The policy the CHUNKS were cut under, not the one this build would use.
    // A loaded artifact reserialized has to keep saying what produced it —
    // stamping the current version on old boundaries is precisely the lie the
    // field exists to prevent, and it would claim vector reuse is safe.
    chunkerPolicy: string,
): Index {
    const stats: CorpusStats = { chunkCount: built.chunks.length, averageLength: built.averageLength };

    return {
        tokenizerId: tokenizer.id,

        searchLexical(query: string, opts: SearchOptions = {}): readonly SearchResult[] {
            const topK = opts.topK ?? DEFAULT_TOP_K;
            const terms = tokenizer.tokenize(query).map((t) => t.term);
            // A query whose terms all vanish is a legitimate answer of
            // nothing, not an error: punctuation, an emoji, a stray bracket.
            if (terms.length === 0 || built.chunks.length === 0) return [];

            const scores = new Map<number, number>();
            for (const term of terms) {
                const list = built.postings.get(term);
                if (list === undefined) continue;
                const documentFrequency = list.length;
                for (const [chunkIndex, termFrequency] of list) {
                    const partial = bm25TermScore(
                        termFrequency,
                        built.lengths[chunkIndex]!,
                        documentFrequency,
                        stats,
                        params,
                    );
                    scores.set(chunkIndex, (scores.get(chunkIndex) ?? 0) + partial);
                }
            }

            const ordered = [...scores.entries()]
                .filter(([, score]) => score > 0)
                // Ties break by chunk order so the same query on the same
                // artifact always returns the same list.
                .sort((x, y) => y[1] - x[1] || x[0] - y[0]);

            const perPage = new Map<number, number>();
            const out: SearchResult[] = [];
            for (const [chunkIndex, score] of ordered) {
                if (out.length >= topK) break;
                const candidate = built.chunks[chunkIndex]!;
                if (opts.maxChunksPerPage !== undefined && candidate.pageNumber !== undefined) {
                    const taken = perPage.get(candidate.pageNumber) ?? 0;
                    if (taken >= opts.maxChunksPerPage) continue;
                    perPage.set(candidate.pageNumber, taken + 1);
                }
                out.push({ chunk: candidate, score, rank: out.length + 1 });
            }
            return out;
        },

        async search(): Promise<readonly SearchResult[]> {
            throw new Error(
                'search requires an embedding provider, and this index has none: its artifact carries ' +
                    'dense === null. Use searchLexical for the lexical half, or build the index with a provider.',
            );
        },

        serialize(): IndexArtifact {
            const postings: Record<string, readonly (readonly [number, number])[]> = {};
            for (const [term, list] of built.postings) postings[term] = list;
            return {
                formatVersion: INDEX_FORMAT_VERSION,
                tokenizerId: tokenizer.id,
                chunkerPolicy,
                bm25: { k1: params.k1, b: params.b, averageLength: built.averageLength },
                chunks: built.stored,
                postings,
                dense,
            };
        },
    };
}

function defaultTokenizer(): Tokenizer {
    return createTokenizer({ stemmer: RSLP_S_FOLDED });
}

/**
 * Indexes `docs`.
 *
 * Refuses an index whose chunks produce no tokens at all. `averageLength`
 * would be zero, it sits in BM25's denominator, every score would be `NaN`,
 * and `NaN` in a comparator returns the order things arrived in — no error,
 * no log, and a ranking that looks like a ranking. Failing here is the same
 * decision as fixing the idf variant: refuse the state that orders wrongly in
 * silence.
 */
export function createIndex(docs: readonly SourceDoc[], opts: IndexOptions = {}): Index {
    const tokenizer = opts.tokenizer ?? defaultTokenizer();
    const chunkOptions = opts.chunkOptions ?? DEFAULT_CHUNK_OPTIONS;
    const params: Bm25Params = {
        k1: opts.k1 ?? DEFAULT_BM25_PARAMS.k1,
        b: opts.b ?? DEFAULT_BM25_PARAMS.b,
    };

    const built = build(docs, tokenizer, chunkOptions);
    if (built.chunks.length > 0 && built.averageLength === 0) {
        throw new Error(
            `createIndex produced ${built.chunks.length} chunks and 0 tokens, so average length is 0 ` +
                'and every BM25 score would be NaN. Check that the tokenizer matches the text: a corpus ' +
                'in a script the tokenizer drops entirely gives exactly this.',
        );
    }
    return makeIndex(built, tokenizer, params, null, CHUNKER_POLICY);
}

/**
 * Rebuilds an index from an artifact.
 *
 * The artifact stores the NAME of the tokenizer, never the tokenizer — a
 * function does not serialize. So loading needs one supplied, and it has to
 * be the one that indexed: terms produced by a different tokenizer would be
 * looked up in postings built by this one, and the misses would look like
 * absence rather than mismatch.
 */
export function loadIndex(artifact: IndexArtifact, opts: { readonly tokenizer?: Tokenizer } = {}): Index {
    if (artifact.formatVersion !== INDEX_FORMAT_VERSION) {
        throw new Error(
            `loadIndex cannot read format version ${artifact.formatVersion}; this build writes and reads ` +
                `version ${INDEX_FORMAT_VERSION}.`,
        );
    }
    const tokenizer = opts.tokenizer ?? defaultTokenizer();
    if (tokenizer.id !== artifact.tokenizerId) {
        throw new Error(
            `loadIndex was given tokenizer "${tokenizer.id}" but the artifact was built with ` +
                `"${artifact.tokenizerId}". Searching with a different tokenizer turns a mismatch into ` +
                'an empty result, which reads as "not in the corpus".',
        );
    }

    const chunks: Chunk[] = artifact.chunks.map((c) => ({
        id: c.id,
        documentId: c.documentId,
        text: c.text,
        span: c.span,
        ...(c.pageNumber === undefined ? {} : { pageNumber: c.pageNumber }),
        ...(c.boxes === undefined ? {} : { boxes: c.boxes }),
    }));
    const postings = new Map<string, [number, number][]>();
    const lengths = new Array<number>(chunks.length).fill(0);
    // An artifact arrives from disk or from the network, so it can be
    // truncated, hand-edited or written by an older build. An out-of-range
    // index would surface as a TypeError deep inside a search; a negative or
    // fractional frequency would quietly skew every length.
    for (const [term, list] of Object.entries(artifact.postings)) {
        const copy: [number, number][] = [];
        for (const [i, tf] of list) {
            if (!Number.isInteger(i) || i < 0 || i >= chunks.length) {
                throw new Error(
                    `loadIndex: the posting for "${term}" points at chunk ${i}, and the artifact has ` +
                        `${chunks.length} chunks.`,
                );
            }
            if (!Number.isInteger(tf) || tf <= 0) {
                throw new Error(
                    `loadIndex: the posting for "${term}" claims ${tf} occurrences in chunk ${i}; a ` +
                        'term is recorded only where it occurs, so this must be a positive integer.',
                );
            }
            copy.push([i, tf]);
            lengths[i] = (lengths[i] ?? 0) + tf;
        }
        postings.set(term, copy);
    }

    const built: Built = {
        chunks,
        stored: artifact.chunks,
        postings,
        lengths,
        averageLength: artifact.bm25.averageLength,
    };
    return makeIndex(
        built,
        tokenizer,
        { k1: artifact.bm25.k1, b: artifact.bm25.b },
        artifact.dense,
        artifact.chunkerPolicy,
    );
}
