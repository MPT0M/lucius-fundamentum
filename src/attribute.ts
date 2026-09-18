/**
 * Says which retrieved passage carries which clause of an answer.
 *
 * The input is the text a model already wrote plus the passages a search
 * already returned. Nothing here rewrites the answer, and nothing here judges
 * whether the passage is a good answer to the question that was asked: this
 * checks SUPPORT — the clause says something the passage contains — and not
 * RELEVANCE. A passage can support a sentence perfectly and still be the wrong
 * passage to have cited, and no amount of work in this file would notice.
 *
 * The promise is auditability, not accuracy.
 */

import type { Span } from './types.js';
import type { Tokenizer } from './tokenizer.js';
import type { SearchResult } from './index-build.js';
import type { AbbreviationList } from './abbreviations.js';
import { luceneIdf } from './bm25.js';
import { sentencesOf, defaultSegmenter } from './sentences.js';
import type { Segmenter } from './sentences.js';

/**
 * Below this share of a clause's weight, no candidate is a clear winner and
 * the clause goes to the next rung.
 *
 * ARBITRARY UNTIL MEASURED, and it is one half of the coverage-versus-noise
 * trade in disguise: raising it cites less and is wrong less often. What it
 * means in plain terms, with weights close to each other, is a ratio — at 0.25,
 * AT MOST THREE of a clause's terms may be absent from the passage for every
 * one that is present. That reading is the one to publish, because a bare
 * `0.25` invites the reader to take it for a similarity threshold, which it is
 * not.
 */
export const MIN_LEXICAL_SUPPORT = 0.25;

/**
 * How far ahead the winner must be before the lexical rung is trusted to have
 * separated the candidates. Below it, two passages are tied and the clause goes
 * to the next rung rather than being decided by a rounding difference.
 *
 * ARBITRARY UNTIL MEASURED, same standing as `FUSION_K` and the BM25
 * parameters. It is MULTIPLICATIVE, so every quantity compared against it has
 * to be positive — see the dense rung, where non-positive cosines are dropped
 * before this is applied.
 */
export const LEXICAL_MARGIN = 1.25;

/** Which rung produced a span. The veto never chooses, so it never appears. */
export type ResolvedBy = 'lexical' | 'dense';

/**
 * One stretch of the answer, and the passage that supports it.
 *
 * Every offset here is in CODE POINTS, and the two spans are measured against
 * DIFFERENT texts: `textSpan` and `anchorOffset` into the answer, `sourceSpan`
 * into the source document. A caller that reindexes one must not reindex the
 * other.
 */
export interface AttributionSpan {
    /** The clause being supported, in the answer. It never moves. */
    readonly textSpan: Span;
    /**
     * Where the marker goes, in the answer. Equal to `textSpan.end` until
     * something pushes it — the anchor moves, the span does not.
     */
    readonly anchorOffset: number;
    /** The stretch of the source document that supports the clause. */
    readonly sourceSpan: Span;
    readonly chunkId: string;
    readonly documentId: string;
    /** See `coverageOf`. Not a probability, and local to these candidates. */
    readonly confidence: number;
    readonly resolvedBy: ResolvedBy;
}

/**
 * What the ruler reads, without needing an instrument of its own.
 *
 * `lexical + dense + unattributed` is the number of clauses examined — they
 * partition. `vetoed` crosses the last two and never the first, because a
 * vetoed winner sends its clause down a rung and is never replaced by the
 * runner-up.
 *
 * These count CLAUSES. `Attribution.spans` counts SPANS, and the two differ
 * whenever coalescence merges two clauses into one marker.
 */
export interface RungCounts {
    readonly lexical: number;
    readonly vetoed: number;
    readonly dense: number;
    readonly unattributed: number;
}

export interface Attribution {
    /** The answer, untouched. */
    readonly text: string;
    readonly spans: readonly AttributionSpan[];
    /**
     * The `results` as received, in order, untouched — no filtering, no
     * reordering. Not a convenience: the marker's number is a position in this
     * list, and it is by being identical in every mode that the number does not
     * change when a streamed message closes. Trimming it to "only what was
     * cited" would move every number.
     */
    readonly sources: readonly SearchResult[];
    readonly rungs: RungCounts;
}

export interface AttributeOptions {
    /** The SAME tokenizer that indexed. See the doc comment on `Tokenizer.id`. */
    readonly tokenizer: Tokenizer;
    /** The same sentence boundary the chunker cut on. */
    readonly segmenter?: Segmenter;
    readonly abbreviations?: AbbreviationList;
}

/** A clause of the answer, with the distinct terms it was reduced to. */
export interface Clause {
    readonly span: Span;
    readonly terms: ReadonlySet<string>;
}

/**
 * Splits the answer into the units that get attributed.
 *
 * The unit is the clause, not the paragraph and not the delta a model streams:
 * it is the smallest stretch that can be true or false on its own, which is the
 * smallest stretch worth pointing a citation at.
 */
export function clausesOf(text: string, opts: AttributeOptions): Clause[] {
    const segmenter = opts.segmenter ?? defaultSegmenter();
    return sentencesOf(text, segmenter, opts.abbreviations).map((span) => ({
        span,
        terms: distinctTerms(text.slice(...utf16Range(text, span)), opts.tokenizer),
    }));
}

/**
 * How many candidates contain each term.
 *
 * The frequency is over the CANDIDATES, not over the corpus, and that is the
 * grandeur the decision actually uses: the job of this rung is to tell these
 * passages apart, and a term present in all of them tells them apart in no way
 * at all, whatever its frequency in the corpus. The cost of the choice is that
 * a term that is rare in the corpus but present everywhere here weighs nothing
 * — correct for choosing between them, wrong for "this clause is about X", and
 * this rung only does the first.
 */
export function candidateFrequencies(
    candidates: readonly ReadonlySet<string>[],
): ReadonlyMap<string, number> {
    const df = new Map<string, number>();
    for (const terms of candidates) {
        for (const term of terms) df.set(term, (df.get(term) ?? 0) + 1);
    }
    return df;
}

/**
 * What a term is worth for telling the candidates APART.
 *
 * Zero when no candidate has it: a term nobody carries cannot separate anybody,
 * and `luceneIdf` would hand it the largest weight in the table — it is only
 * documented as strictly positive and decreasing for `df` in `1..N`, and `0` is
 * outside what the function promises.
 */
export function separationWeight(documentFrequency: number, candidateCount: number): number {
    if (documentFrequency <= 0) return 0;
    return luceneIdf(candidateCount, documentFrequency);
}

/**
 * What a term is worth for judging whether the passage SUPPORTS the clause.
 *
 * Here the absent term does count — it is a word the clause says and the
 * passage does not have — but it is capped at the weight of the rarest OBSERVED
 * term. `df = 0` among the candidates means UNOBSERVED, not "rarer than
 * everything else", and without the cap it would carry the largest weight in
 * the sum on the strength of no evidence at all.
 *
 * Even capped it is the largest weight available, so the absent terms dominate
 * whenever they outnumber the matched ones. That is the intended direction —
 * see `MIN_LEXICAL_SUPPORT` — and it means `coverageOf` is an upper bound, not
 * an estimate.
 */
export function sustainWeight(documentFrequency: number, candidateCount: number): number {
    return luceneIdf(candidateCount, Math.max(documentFrequency, 1));
}

/**
 * The share of a clause's weight that a passage carries: the number published
 * as `confidence`.
 *
 * It measures SUPPORT — how much of what the clause says is present in the
 * passage — and it is not a probability that the citation is right, because a
 * faithful citation of the wrong passage scores just as well.
 *
 * It is also LOCAL to the candidates it was computed over: the weights come
 * from their frequencies, so the same clause and the same passage score
 * differently under a different `topK`. Comparing the number across calls means
 * nothing, which is the warning `SearchResult.score` already carries.
 *
 * Returns `null` for a clause with no terms at all — a lone dash, a line that
 * is only a formula, an emoji. There is no fraction to compute, and answering
 * `NaN` would send it down the rungs to ask a network which passage supports a
 * clause with no words in it.
 */
export function coverageOf(
    clauseTerms: ReadonlySet<string>,
    passageTerms: ReadonlySet<string>,
    df: ReadonlyMap<string, number>,
    candidateCount: number,
): number | null {
    let total = 0;
    let carried = 0;
    for (const term of clauseTerms) {
        const w = sustainWeight(df.get(term) ?? 0, candidateCount);
        total += w;
        if (passageTerms.has(term)) carried += w;
    }
    if (total <= 0) return null;
    return carried / total;
}

/** The lexical rung's verdict for one clause. */
export type LexicalOutcome =
    | { readonly kind: 'clear'; readonly index: number; readonly confidence: number }
    | { readonly kind: 'tied' }
    | { readonly kind: 'unattributable' };

/**
 * Ranks the candidates by separation weight and says whether the winner is
 * clear enough to trust.
 *
 * "Clear" is two conditions and they answer different questions. The coverage
 * floor asks whether the passage supports the clause at all; the margin asks
 * whether it supports it better than the next one. A passage can pass either
 * alone and still be the wrong thing to cite.
 */
export function lexicalRung(
    clause: Clause,
    candidates: readonly ReadonlySet<string>[],
    df: ReadonlyMap<string, number>,
): LexicalOutcome {
    if (clause.terms.size === 0) return { kind: 'unattributable' };

    let best = -1;
    let bestWeight = 0;
    let runnerUp = 0;
    candidates.forEach((terms, index) => {
        let weight = 0;
        for (const term of clause.terms) {
            if (terms.has(term)) weight += separationWeight(df.get(term) ?? 0, candidates.length);
        }
        if (weight > bestWeight) {
            runnerUp = bestWeight;
            bestWeight = weight;
            best = index;
        } else if (weight > runnerUp) {
            runnerUp = weight;
        }
    });

    if (best < 0 || bestWeight <= 0) return { kind: 'unattributable' };

    const confidence = coverageOf(clause.terms, candidates[best]!, df, candidates.length);
    if (confidence === null) return { kind: 'unattributable' };
    if (confidence < MIN_LEXICAL_SUPPORT) return { kind: 'tied' };
    if (runnerUp > 0 && bestWeight < LEXICAL_MARGIN * runnerUp) return { kind: 'tied' };
    return { kind: 'clear', index: best, confidence };
}

/** The distinct terms of a text, as the injected tokenizer sees them. */
export function distinctTerms(text: string, tokenizer: Tokenizer): ReadonlySet<string> {
    const out = new Set<string>();
    for (const token of tokenizer.tokenize(text)) out.add(token.term);
    return out;
}

/**
 * Translates a code point span into the UTF-16 range `String.prototype.slice`
 * wants.
 *
 * Every position in this package is a code point, and JavaScript indexes
 * strings in UTF-16 units — an emoji is one of the first and two of the second.
 * Slicing with a code point offset is the single most available way to
 * reintroduce the displacement bug this package exists to remove.
 */
function utf16Range(text: string, span: Span): [number, number] {
    const points = Array.from(text);
    const start = points.slice(0, span.start).join('').length;
    const end = start + points.slice(span.start, span.end).join('').length;
    return [start, end];
}
