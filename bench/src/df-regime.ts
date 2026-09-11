/**
 * Which terms would score NEGATIVE under the classic idf, and how much of the
 * text they account for.
 *
 * This is the measurement behind two decisions that only look separate.
 *
 * The first is §5's choice of BM25 variant. The classic Robertson–Spärck Jones
 * idf, `ln((N - df + 0.5) / (df + 0.5))`, goes below zero once a term appears
 * in more than half the chunks: a document containing the term is then ranked
 * BELOW one that does not, silently, with no error anywhere. Lucene's form
 * adds one inside the logarithm and cannot go negative. Choosing between them
 * is choosing a failure mode, which is why it is fixed and not configurable.
 *
 * The second is §3's refusal of a stop-word list. The argument there is that
 * BM25 already grades a ubiquitous term to nearly nothing, so a list is a
 * blunt instrument whose errors are asymmetric — one common word too many
 * costs bytes of postings, one negation removed costs the meaning of the
 * sentence. That argument only holds while the grading is toward zero. Under
 * the classic idf `não` is not graded to zero, it is INVERTED, and the two
 * decisions become one.
 *
 * The number was first measured with no stemmer. A stemmer collapses forms,
 * which raises document frequency, which can push more terms across the line
 * — so it has to be measured again under whatever the default stemmer is, and
 * this module is what measures it.
 */

import { chunk, type ChunkOptions, type SourceDoc } from '../../src/chunker.js';
import type { Tokenizer } from '../../src/tokenizer.js';

/**
 * A term and what the corpus says about it. Deliberately NOT `TermFrequency`:
 * it carries no count of occurrences inside a chunk, and that name collides
 * with `ScoredTerm.termFrequency` in `src/bm25.ts`, which does.
 */
export interface TermDfEntry {
    readonly term: string;
    /** Number of chunks the term occurs in. */
    readonly documentFrequency: number;
    /** `ln((N - df + 0.5) / (df + 0.5))` — the form this package does NOT use. */
    readonly classicIdf: number;
}

export interface DfRegime {
    readonly chunkCount: number;
    readonly vocabularySize: number;
    /** Every occurrence of every term, for the share below. */
    readonly totalOccurrences: number;
    /** Terms the classic idf would score below zero, most frequent first. */
    readonly negativeIdfTerms: readonly TermDfEntry[];
    /** How much of the running text those terms are. */
    readonly negativeIdfOccurrenceShare: number;
}

/** The form this package refuses. Negative exactly when `df > N / 2`. */
export function classicIdf(chunkCount: number, documentFrequency: number): number {
    return Math.log((chunkCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

/**
 * Chunks `doc`, tokenizes every chunk with `tokenizer`, and reports the terms
 * whose classic idf falls below zero.
 *
 * Tokenizing per chunk and not over the whole document is not an
 * implementation detail: the index is over chunks, so document frequency
 * counts chunks, and a term is counted once per chunk however often it occurs
 * there. Chunks overlap, so a term in the overlap counts in both — which is
 * what the index will see too.
 */
export function measureDfRegime(doc: SourceDoc, opts: ChunkOptions, tokenizer: Tokenizer): DfRegime {
    const chunks = chunk(doc, opts);
    const documentFrequency = new Map<string, number>();
    let totalOccurrences = 0;

    const occurrences = new Map<string, number>();
    // One tokenization pass per chunk. Tokenizing twice — once for document
    // frequency and once for occurrences — cost eight seconds of every CI run
    // over this corpus, which is the whole budget of several other files.
    for (const piece of chunks) {
        const inThisChunk = new Set<string>();
        for (const token of tokenizer.tokenize(piece.text)) {
            totalOccurrences += 1;
            inThisChunk.add(token.term);
            occurrences.set(token.term, (occurrences.get(token.term) ?? 0) + 1);
        }
        for (const term of inThisChunk) {
            documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
        }
    }

    const negative: TermDfEntry[] = [];
    for (const [term, df] of documentFrequency) {
        const idf = classicIdf(chunks.length, df);
        if (idf < 0) negative.push({ term, documentFrequency: df, classicIdf: idf });
    }
    negative.sort((a, b) => b.documentFrequency - a.documentFrequency || a.term.localeCompare(b.term));

    const negativeOccurrences = negative.reduce((sum, t) => sum + (occurrences.get(t.term) ?? 0), 0);

    return {
        chunkCount: chunks.length,
        vocabularySize: documentFrequency.size,
        totalOccurrences,
        negativeIdfTerms: negative,
        negativeIdfOccurrenceShare: totalOccurrences === 0 ? 0 : negativeOccurrences / totalOccurrences,
    };
}
