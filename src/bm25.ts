/**
 * BM25, in the form Lucene uses.
 *
 * There is no single BM25. Kamphuis et al. (ECIR 2020) counted the variants
 * in circulation and found that papers citing "BM25" mean measurably
 * different functions. The differences are small in ranking and one of them
 * is not small at all in failure mode, which is why this package fixes the
 * variant instead of offering it.
 *
 * The classic Robertson–Spärck Jones idf, `ln((N - df + 0.5) / (df + 0.5))`,
 * turns NEGATIVE once a term sits in more than half the chunks. A negative
 * weight does not mean "this term hardly matters"; it means a chunk that
 * CONTAINS the term is ranked below one that does not. Nothing throws, no
 * number looks wrong, and the order is inverted. Measured on the corpus
 * (`bench/src/df-regime.ts`), 29 terms of 9,051 fall there — a third of a
 * percent of the vocabulary, but two fifths of the running text, and among
 * them `nao`. A search for "não sustenta" would prefer the chunks that do not
 * say it.
 *
 * Lucene adds one inside the logarithm. The weight approaches zero and never
 * crosses it, so a ubiquitous term stops discriminating instead of arguing
 * backwards. That is a choice between failure modes, not between tastes, and
 * publishing the other one as an option would be publishing a trap as a
 * setting.
 *
 * `k1` and `b` ARE offered, because they are calibration rather than
 * correctness: getting them wrong makes the ranking worse, not inverted.
 */

/** How fast term frequency saturates, and how hard length is punished. */
export interface Bm25Params {
    /** Saturation. Higher means repeated occurrences keep counting for longer. */
    readonly k1: number;
    /** Length normalization, 0 to 1. At 0 length is ignored; at 1 it fully divides. */
    readonly b: number;
}

/**
 * Reference values, and arbitrary until the harness calibrates them — the
 * same standing as `maxChunkCodePoints`. They are the ones Lucene, Elastic
 * and most of the literature use, so a number measured here is comparable
 * with a number measured elsewhere.
 */
export const DEFAULT_BM25_PARAMS: Readonly<Bm25Params> = { k1: 1.2, b: 0.75 };

/** What a score needs to know about the index it is scored against. */
export interface CorpusStats {
    /** Number of chunks in the index. */
    readonly chunkCount: number;
    /** Mean tokens per chunk, overlap counted in each chunk that repeats it. */
    readonly averageLength: number;
}

/**
 * `ln(1 + (N - df + 0.5) / (df + 0.5))`.
 *
 * Strictly positive for every `df` in `1..N`, decreasing as `df` grows. A
 * term in every chunk still weighs a little more than nothing, which is the
 * honest statement: it does not help tell chunks apart, and it does not argue
 * against the chunks that contain it.
 */
export function luceneIdf(chunkCount: number, documentFrequency: number): number {
    return Math.log(1 + (chunkCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

/**
 * One term's contribution to one chunk's score.
 *
 * `chunkLength` is counted in TOKENS of that chunk, not code points, and
 * overlap counts in every chunk that repeats it — the same number the index
 * averaged into `stats.averageLength`. Mixing the two units would make `b`
 * punish the wrong thing.
 *
 * Returns zero when the term is absent, so a caller can sum over query terms
 * without branching.
 */
export function bm25TermScore(
    termFrequency: number,
    chunkLength: number,
    documentFrequency: number,
    stats: CorpusStats,
    params: Bm25Params = DEFAULT_BM25_PARAMS,
): number {
    if (termFrequency <= 0 || documentFrequency <= 0) return 0;
    const { k1, b } = params;
    const normalized = stats.averageLength > 0 ? chunkLength / stats.averageLength : 1;
    const saturation = termFrequency + k1 * (1 - b + b * normalized);
    return luceneIdf(stats.chunkCount, documentFrequency) * ((termFrequency * (k1 + 1)) / saturation);
}

/** A term of the query, with what the index knows about it. */
export interface ScoredTerm {
    /** Occurrences of the term in this chunk. */
    readonly termFrequency: number;
    /** Chunks of the index that contain the term. */
    readonly documentFrequency: number;
}

/**
 * A chunk's score for a query: the sum over the query's terms.
 *
 * A term repeated in the query is summed once per occurrence, which is what
 * BM25 does and what a caller expecting "duas vezes pesa mais" would expect.
 */
export function bm25Score(
    terms: readonly ScoredTerm[],
    chunkLength: number,
    stats: CorpusStats,
    params: Bm25Params = DEFAULT_BM25_PARAMS,
): number {
    let total = 0;
    for (const t of terms) {
        total += bm25TermScore(t.termFrequency, chunkLength, t.documentFrequency, stats, params);
    }
    return total;
}
