/**
 * Builds a searchable index over documents, and answers queries against it.
 *
 * This is where the pieces meet: the chunker cuts, the tokenizer turns each
 * chunk into terms that remember where they came from, and BM25 scores. The
 * index owns the numbers those pieces disagree about if nobody owns them —
 * `averageLength`, `k1`, `b` — and writes them into the artifact, so a score
 * is reproducible from the artifact alone and not from whoever called.
 *
 * Both arms live here. `createIndex` builds the lexical one, synchronously and
 * without leaving the machine; `createDenseIndex` adds vectors, which is async
 * because embedding is and separate because it costs money.
 *
 * An index without vectors still refuses `search` rather than pretending —
 * answering a hybrid query with half a hybrid, shaped like a whole answer, is
 * worse than saying no. The refusal depends on the artifact rather than on how
 * the index was built: one carrying vectors but loaded without a provider gets
 * the same refusal, because vectors nobody can compare the query against
 * search nothing.
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
import { dot, normalize, packVectors, unpackVectors } from './vector.js';
import { assertChunkCeilingFits, assertChunksFit, type EmbeddingProvider } from './embedding.js';

/**
 * The version of the CHUNKING LOGIC, not of its parameters.
 *
 * An artifact records this so that reusing vectors across a reindex can tell
 * whether the boundaries would still fall in the same places. It cannot be
 * derived from `maxChunkCodePoints` and `maxOverlapCodePoints`: two fixes to
 * the chunker have already moved every boundary in every document while
 * leaving both numbers at 1200 and 160. A derived id would have claimed
 * compatibility and reused vectors against chunks that no longer exist.
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
    /**
     * How many results to return. Defaults to 10.
     *
     * `searchLexical` honours any value: it ranks every chunk a query term
     * reached. `search` cannot, and the ceiling is not documented anywhere the
     * caller would look otherwise: it fuses two lists of at most
     * `FUSION_DEPTH` each, so the pool it draws from holds at most
     * `2 * FUSION_DEPTH` chunks — 200 at the defaults. Asking for 300 returns
     * 200, with no error, because the other hundred were never candidates.
     *
     * The same ceiling reaches `maxChunksPerPage`: a cap drawing from a pool
     * of 200 that happen to cluster on five pages returns five results where
     * an uncapped corpus would have offered ten. That is the page cap
     * shortening a list for a reason that is not relevance, which is the
     * failure the cap's own placement was chosen to avoid — declared here as a
     * debt rather than fixed, because raising the depth trades it for cost on
     * every query and neither side has been measured.
     */
    readonly topK?: number;
    /** At most this many results from any one page. Ignored for unpaged sources. */
    readonly maxChunksPerPage?: number;
}

export interface SearchResult {
    readonly chunk: Chunk;
    /**
     * What the number means depends on which method produced it, and the
     * difference is not cosmetic.
     *
     * From `searchLexical` it is the BM25 score: unbounded above, dependent on
     * the corpus, comparable only within one result list.
     *
     * From `search` it is the reciprocal-rank sum, between
     * `1/(FUSION_K+FUSION_DEPTH)` and `2/(FUSION_K+1)` — 0.00625 and 0.033 at
     * the defaults. The floor is not near zero and cannot be: a chunk that
     * reaches the fused list at all was ranked within the depth by at least
     * one arm, and the worst such rank is `FUSION_DEPTH`. It is NOT a similarity
     * and it is NOT a probability: a result scoring 0.03 is not "3% relevant".
     * It carries no absolute meaning at all, by construction, because the
     * fusion reads positions precisely so that it never has to trust the
     * scales underneath. Use it to order, never to threshold.
     */
    readonly score: number;
    /** 1-based position in this result list. */
    readonly rank: number;
}

export interface Index {
    readonly tokenizerId: string;
    /** The lexical arm alone: BM25 over the postings, synchronous and free. */
    searchLexical(query: string, opts?: SearchOptions): readonly SearchResult[];
    /**
     * The hybrid search: both arms, fused by reciprocal rank.
     *
     * A chunk both arms found outranks one a single arm placed first, which is
     * the claim hybrid retrieval makes. Refuses while the artifact carries no
     * vectors — `searchLexical` is what answers then, and the refusal says so.
     * See `SearchResult.score`: the number it returns is not a similarity.
     */
    search(query: string, opts?: SearchOptions): Promise<readonly SearchResult[]>;
    serialize(): IndexArtifact;
}

const DEFAULT_TOP_K = 10;

/**
 * The constant in the RRF denominator.
 *
 * 60 is the value the original paper used and the one every implementation
 * since has copied, which makes it a convention rather than a measurement. It
 * flattens the difference between the top positions: at k=60 the gap between
 * rank 1 and rank 2 is under two percent of the score, so a chunk both arms
 * placed high beats a chunk one arm placed first. That is the behaviour this
 * fusion is for, and it is why the number is large relative to `topK`.
 *
 * ARBITRARY UNTIL MEASURED, and the ruler is what measures it. It goes into
 * the round's report beside the numbers it produced, because a recall figure
 * without the k that produced it cannot be compared with another.
 */
export const FUSION_K = 60;

/**
 * How deep each arm ranks before the lists are fused.
 *
 * Not a detail, but the effect is narrower than it looks, and the obvious
 * description of it is wrong. Take a chunk ranked 40th by one arm and 3rd by
 * the other. At depth 100 it scores 1/100 + 1/63 = 0.025873; at depth 10 the
 * 40th place falls outside the slice and it scores 1/63 = 0.015873 — it is
 * still in the fused list, through the arm that ranked it 3rd. Depth does not
 * decide whether a chunk APPEARS. It decides whether the agreement between the
 * two arms is allowed to count: at 0.025873 that chunk beats one a single arm
 * put first (1/61 = 0.016393), and at 0.015873 it loses to it, by 0.00052.
 *
 * Deeper is not free, and the algebra says exactly how far it is worth going.
 * Two arms agreeing at rank r beat one arm leading alone when
 * `2/(k+r) > 1/(k+1)`, which holds for `r < k+2`: agreement wins through rank
 * 61, ties EXACTLY at 62 — `1/122 + 1/122` and `1/61` are the same double,
 * since doubling is exact in binary — and loses from 63 on. So with k at 60,
 * the last 38 ranks of a depth of 100 admit chunks whose double agreement can
 * no longer outrank a single arm's lead. They still enter the pool and can
 * still be the only candidates a sparse query produces.
 *
 * 100 is ten times the default `topK`, chosen for that ratio and nothing more.
 * ARBITRARY UNTIL MEASURED, and published with the numbers it produced.
 */
export const FUSION_DEPTH = 100;

/**
 * Reciprocal rank fusion: combines ranked lists by POSITION, never by score.
 *
 *     score(chunk) = Σ  1 / (k + rank in list i)
 *
 * Reading positions rather than scores is the whole point, because the two
 * arms produce numbers that do not live on the same scale — BM25 is unbounded
 * and corpus-dependent, cosine sits in [-1, 1]. Adding them would be adding
 * metres to kilograms, and normalising them first requires knowing each arm's
 * range, which depends on the corpus and on the provider.
 *
 * Measured on 2026-09-13, the provider half of that problem is real and not
 * theoretical: on the same query-and-passage pair — a question about school
 * age against a recipe for salt cod — `gemini-embedding-2` scores 0.530 and
 * `qwen3.7-text-embedding` scores 0.257. A threshold calibrated on one would
 * mean nothing on the other. Positions have no such problem.
 *
 * A chunk found by both arms accumulates two contributions and rises above one
 * found by a single arm, even when that single arm ranked it first. Agreement
 * between two methods that fail differently is worth more than leadership in
 * one — that is the whole claim of hybrid search, and it is this sum.
 *
 * DEBT, named at the line that creates it: a chunk absent from a list is
 * treated as ranked lower than every chunk present in it, which is right while
 * every chunk can compete in both arms. The day a chunk cannot — a figure, an
 * audio segment, anything the lexical arm has no terms for — absence stops
 * being evidence and starts being a structural penalty: text would get two
 * chances to score and a figure one, and figures would sink for a reason that
 * has nothing to do with relevance. Whether the fix is to divide by the number
 * of lists a chunk was eligible for, or something else, is not decided here,
 * because nothing in this library can yet produce an ineligible chunk and a
 * rule written against no case is a rule nobody can test.
 *
 * Two things make that deferral safe rather than lazy. The obvious fix is
 * probably wrong: dividing by the number of lists a chunk was eligible for
 * would PUNISH text for being eligible in an arm that did not find it — a
 * passage at dense rank 1 and absent from the lexical list would score
 * (1/61)/2 = 0.0082 while a figure at dense rank 1, eligible in one arm only,
 * would score (1/61)/1 = 0.0164, and the figure would pass the passage. That
 * is the inverse of the problem the division is meant to solve, and it is the
 * first real case that should decide, not this comment.
 *
 * And the rule as written is already pinned: the test
 * 'every chunk an arm ranked within the depth reaches the fused list' asserts
 * that a chunk found by one arm scores exactly 1/61, with no penalty term. The
 * day someone adds a divisor, that test turns red and the change becomes
 * deliberate instead of silent.
 */
function fuseByRank(lists: readonly (readonly number[])[], k: number): Map<number, number> {
    const fused = new Map<number, number>();
    for (const list of lists) {
        for (let position = 0; position < list.length; position += 1) {
            const chunkIndex = list[position]!;
            // Rank is 1-based: the first item scores 1/(k+1), not 1/k.
            fused.set(chunkIndex, (fused.get(chunkIndex) ?? 0) + 1 / (k + position + 1));
        }
    }
    return fused;
}

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

/**
 * The dense arm as it lives in memory: vectors already unit length, and the
 * provider that has to embed the query with the same model that embedded the
 * chunks. The artifact stores the same thing packed; this is the unpacked side.
 */
interface DenseRuntime {
    readonly providerId: string;
    readonly dimensions: number;
    /** One per chunk, in chunk order, already normalized. */
    readonly vectors: readonly (readonly number[])[];
    readonly provider: EmbeddingProvider;
}

/**
 * Orders chunk indices by score, drops the non-positive, and cuts to `depth`.
 *
 * Extracted so the two arms and the final list order by the same rule.
 * Ordering lists by different rules and then comparing them would produce a
 * ranking neither arm agreed to.
 *
 * Zero and below are dropped, and the two arms mean different things by
 * it. In BM25 a non-positive score is a chunk no query term reached. In
 * cosine it is a chunk pointing away from the query — orthogonal or
 * opposite — which is worse than absent: returning it would fill a
 * topK of 10 with the least related chunks in the corpus whenever fewer
 * than ten are related at all.
 *
 * This was left as a named debt because the deterministic provider
 * hashes near-uniformly and reproduces no cone, so the suite could
 * neither confirm nor dismiss the empty-result risk. Measured against
 * two real providers on 2026-09-13, over six short Portuguese texts
 * written for the purpose — three sharing a subject, three sharing
 * nothing: a question about school age, a recipe, an engine, the tides.
 *
 * TWO POPULATIONS, and only the second is the one this filter cuts:
 *
 *   document x document, both sides through embedDocuments, 15 pairs
 *   each (C(6,2)):
 *     gemini-embedding-2       0 non-positive, lowest 0.579
 *     qwen3.7-text-embedding   0 non-positive, lowest 0.251
 *
 *   query x document, the query through embedQuery and the passages
 *   through embedDocuments — which is what `search` compares, and on
 *   Gemini the two sides carry different task prefixes:
 *     gemini-embedding-2       6 scores, 0.837 down to 0.530
 *     qwen3.7-text-embedding   6 scores, 0.838 down to 0.257
 *
 * In these thirty document pairs and twelve query scores nothing was
 * non-positive, and the lowest of all was 0.251 — between texts chosen
 * to have nothing in common. That is evidence of a cone, not proof of
 * one: six hand-written sentences are not this corpus, whose chunks run
 * near 1119 code points, and two providers are not every provider. What
 * it does settle is the question the debt was really about — whether
 * the empty case is something the suite failed to reproduce or
 * something that does not arise — and it points firmly at the second.
 * The filter stays, now guarding against an artifact built wrong rather
 * than against a corpus that fails to match.
 *
 * Ties break by chunk order so the same query on the same artifact always
 * returns the same list. That is part of the ordering rule and not a detail:
 * a fused result is reproducible only because the arms feeding it are.
 */
function rankIndices(
    scores: ReadonlyMap<number, number>,
    depth: number,
): readonly number[] {
    return (
        [...scores.entries()]
            .filter(([, score]) => score > 0)
            .sort((x, y) => y[1] - x[1] || x[0] - y[0])
            .slice(0, depth)
            .map(([chunkIndex]) => chunkIndex)
    );
}

/**
 * Turns per-chunk scores into the ranked, capped list both arms return.
 *
 * Extracted the moment the dense arm needed it: the lexical version was
 * written once and about to be written a second time, and this repository has
 * history with the twin fixed on one side only. Ordering, the tie rule and the
 * page cap have to be the same for both, or the fusion of the two lists in
 * `search` would compare things ordered by different rules.
 */
function rankAndCap(
    scores: ReadonlyMap<number, number>,
    chunks: readonly Chunk[],
    topK: number,
    maxChunksPerPage: number | undefined,
): readonly SearchResult[] {
    // The ordering, the tie rule and the non-positive filter live in
    // `rankIndices`, called here and by both arms, so none of them can drift
    // apart. They were written out twice for one commit and that is exactly
    // the twin this extraction exists to prevent.
    const ordered = rankIndices(scores, Number.POSITIVE_INFINITY);

    const perPage = new Map<number, number>();
    const out: SearchResult[] = [];
    for (const chunkIndex of ordered) {
        if (out.length >= topK) break;
        const candidate = chunks[chunkIndex]!;
        const score = scores.get(chunkIndex)!;
        if (maxChunksPerPage !== undefined && candidate.pageNumber !== undefined) {
            const taken = perPage.get(candidate.pageNumber) ?? 0;
            if (taken >= maxChunksPerPage) continue;
            perPage.set(candidate.pageNumber, taken + 1);
        }
        out.push({ chunk: candidate, score, rank: out.length + 1 });
    }
    return out;
}

function makeIndex(
    built: Built,
    tokenizer: Tokenizer,
    params: Bm25Params,
    dense: DenseRuntime | null,
    // The policy the CHUNKS were cut under, not the one this build would use.
    // A loaded artifact reserialized has to keep saying what produced it —
    // stamping the current version on old boundaries is precisely the lie the
    // field exists to prevent, and it would claim vector reuse is safe.
    chunkerPolicy: string,
): Index {
    const stats: CorpusStats = { chunkCount: built.chunks.length, averageLength: built.averageLength };

    /**
     * BM25 over the postings. Pulled out of `searchLexical` so that the fusion
     * scores the same way the lexical arm does, by calling the same function
     * rather than by repeating it. This repository has history with a fix
     * applied to one twin and not the other.
     */
    function lexicalScores(query: string): Map<number, number> {
        const scores = new Map<number, number>();
        const terms = tokenizer.tokenize(query).map((t) => t.term);
        // A query whose terms all vanish is a legitimate answer of nothing,
        // not an error: punctuation, an emoji, a stray bracket.
        if (terms.length === 0 || built.chunks.length === 0) return scores;

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
        return scores;
    }

    /** Cosine against every chunk vector. One provider call, for the query. */
    async function denseScores(query: string, runtime: DenseRuntime): Promise<Map<number, number>> {
        const raw = await runtime.provider.embedQuery(query);
        if (raw.length !== runtime.dimensions) {
            throw new Error(
                `provider ${runtime.providerId} returned a ${raw.length}-dimension vector for the query, ` +
                    `but the index was built with ${runtime.dimensions}`,
            );
        }
        // The query is normalized for the same reason the chunks were: with
        // both at unit length the dot product IS the cosine, so the score
        // means the same thing across queries. Skipping it would leave the
        // order right and the number meaningless.
        const q = normalize([...raw]);

        const scores = new Map<number, number>();
        for (let i = 0; i < runtime.vectors.length; i += 1) {
            scores.set(i, dot(q, runtime.vectors[i]!));
        }
        return scores;
    }

    return {
        tokenizerId: tokenizer.id,

        searchLexical(query: string, opts: SearchOptions = {}): readonly SearchResult[] {
            const topK = opts.topK ?? DEFAULT_TOP_K;
            return rankAndCap(lexicalScores(query), built.chunks, topK, opts.maxChunksPerPage);
        },

        async search(query: string, opts: SearchOptions = {}): Promise<readonly SearchResult[]> {
            if (dense === null) {
                throw new Error(
                    'search requires an embedding provider, and this index has none: its artifact carries ' +
                        'dense === null. Use searchLexical for the lexical half, or build the index with a provider.',
                );
            }
            const topK = opts.topK ?? DEFAULT_TOP_K;
            if (built.chunks.length === 0) return [];

            // Both arms rank to FUSION_DEPTH and WITHOUT the page cap. Capping
            // per arm first would drop a chunk from one list for a reason that
            // is not its relevance, and the fusion would read that absence as
            // the arm ranking it low. The cap belongs to the list a caller
            // receives, so it is applied once, at the end, to the fused list.
            const lexical = rankIndices(lexicalScores(query), FUSION_DEPTH);
            const semantic = rankIndices(await denseScores(query, dense), FUSION_DEPTH);

            const fused = fuseByRank([lexical, semantic], FUSION_K);
            return rankAndCap(fused, built.chunks, topK, opts.maxChunksPerPage);
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
                dense:
                    dense === null
                        ? null
                        : {
                              providerId: dense.providerId,
                              dimensions: dense.dimensions,
                              vectors: packVectors(dense.vectors),
                          },
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
 * Builds an index with both arms.
 *
 * Async because embedding is, and separate from `createIndex` rather than a
 * flag on it: this is the call that costs money and leaves the machine, and a
 * signature that says so is worth more than one option fewer. The lexical
 * index stays synchronous and free.
 *
 * The window guard runs in both layers before a single call is paid for — the
 * cheap parameter check first, then every chunk that was actually cut. The
 * order matters: an obviously wrong configuration fails without touching the
 * network.
 */
export async function createDenseIndex(
    docs: readonly SourceDoc[],
    provider: EmbeddingProvider,
    opts: IndexOptions = {},
): Promise<Index> {
    const chunkOptions = opts.chunkOptions ?? DEFAULT_CHUNK_OPTIONS;
    assertChunkCeilingFits(chunkOptions.maxChunkCodePoints, provider);

    const lexical = createIndex(docs, opts);
    const artifact = lexical.serialize();
    assertChunksFit(artifact.chunks, provider);

    const vectors = artifact.chunks.length === 0
        ? []
        : await embedAll(artifact.chunks.map((c) => c.text), provider);

    return loadIndex(
        {
            ...artifact,
            dense: {
                providerId: provider.id,
                dimensions: provider.dimensions,
                vectors: packVectors(vectors),
            },
        },
        { tokenizer: opts.tokenizer ?? defaultTokenizer(), provider },
    );
}

/**
 * Embeds every chunk and normalizes once, at index time.
 *
 * Normalizing here and not at query time is what makes the hot loop a dot
 * product instead of a cosine: no square root per chunk, on every search, for
 * a value that never changes.
 *
 * The count is checked because a provider that silently returns fewer vectors
 * than inputs would shift every subsequent chunk onto the wrong vector — an
 * off-by-one with no exception and no symptom except results that are subtly
 * wrong forever.
 */
async function embedAll(
    texts: readonly string[],
    provider: EmbeddingProvider,
): Promise<readonly (readonly number[])[]> {
    const raw = await provider.embedDocuments(texts);
    if (raw.length !== texts.length) {
        throw new Error(
            `provider ${provider.id} returned ${raw.length} vectors for ${texts.length} chunks; ` +
                'the dense arm needs exactly one per chunk, in order',
        );
    }
    return raw.map((v, i) => {
        if (v.length !== provider.dimensions) {
            throw new Error(
                `provider ${provider.id} returned a ${v.length}-dimension vector for chunk ${i}, ` +
                    `but reports ${provider.dimensions} dimensions`,
            );
        }
        return normalize([...v]);
    });
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
export function loadIndex(
    artifact: IndexArtifact,
    opts: { readonly tokenizer?: Tokenizer; readonly provider?: EmbeddingProvider } = {},
): Index {
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
        denseFromArtifact(artifact, opts.provider),
        artifact.chunkerPolicy,
    );
}

/**
 * Rebuilds the in-memory dense arm from a stored artifact.
 *
 * Refuses a provider that is not the one that embedded the chunks, for the
 * same reason `loadIndex` refuses the wrong tokenizer: vectors from two models
 * share no space, so comparing them produces numbers that look like scores and
 * rank by nothing. An index with vectors but no provider stays searchable
 * lexically — `search` is what refuses, and it says why.
 *
 * The absence test is `== null`, which catches `undefined` as well, and that
 * is the whole point rather than a shorthand. `dense` is a required field of
 * the type, but the type is a compile-time promise and an artifact arrives at
 * runtime — including one written by the release before this field existed,
 * which carries no `dense` key at all. That artifact declares the same
 * `formatVersion`, passes the version check, and with `=== null` fell through
 * to read `.providerId` off `undefined`: a raw TypeError, from the function
 * whose whole job is refusing artifacts it cannot use. An index built before
 * the dense arm shipped is not broken, it simply has no vectors, and the
 * honest answer is the lexical one it already supports.
 *
 * `formatVersion` was NOT bumped for this. Bumping it would refuse a lexical
 * artifact that this build can read perfectly well, which trades a crash for a
 * different failure rather than removing one. The version exists for a change
 * that makes an old artifact unreadable; adding an optional arm is not that.
 */
function denseFromArtifact(
    artifact: IndexArtifact,
    provider: EmbeddingProvider | undefined,
): DenseRuntime | null {
    if (artifact.dense == null || provider === undefined) return null;

    // Present but malformed is a third case, and it used to be indistinguishable
    // from the first: an artifact hand-edited or truncated between the `dense`
    // key and its contents would reach the comparisons below and fail on a
    // property of the wrong type, far from here. Same reasoning as the posting
    // validation above, applied to the arm that arrived later.
    const stored = artifact.dense;
    if (
        typeof stored.providerId !== 'string' ||
        !Number.isInteger(stored.dimensions) ||
        typeof stored.vectors !== 'string'
    ) {
        throw new Error(
            'loadIndex: the artifact has a `dense` section, but it is not shaped like one — it needs ' +
                '`providerId` (string), `dimensions` (integer) and `vectors` (string).',
        );
    }

    if (provider.id !== artifact.dense.providerId) {
        throw new Error(
            `loadIndex was given embedding provider "${provider.id}" but the artifact was built with ` +
                `"${artifact.dense.providerId}". Vectors from two models do not share a space, and ` +
                'comparing them yields numbers that rank by nothing.',
        );
    }
    if (provider.dimensions !== artifact.dense.dimensions) {
        throw new Error(
            `provider "${provider.id}" reports ${provider.dimensions} dimensions but the artifact stores ` +
                `${artifact.dense.dimensions}`,
        );
    }

    const vectors = unpackVectors(artifact.dense.vectors, artifact.dense.dimensions);
    if (vectors.length !== artifact.chunks.length) {
        throw new Error(
            `artifact carries ${vectors.length} vectors for ${artifact.chunks.length} chunks; ` +
                'the dense arm needs exactly one per chunk, in chunk order',
        );
    }
    return {
        providerId: artifact.dense.providerId,
        dimensions: artifact.dense.dimensions,
        vectors,
        provider,
    };
}
