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
import { assertChunksFit, embedDocumentsChecked } from './embedding.js';
import type { EmbeddingProvider } from './embedding.js';
import { dot } from './vector.js';
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
 * These count CLAUSES, each one once: a clause whose winner the veto rejects
 * twice still adds one to `vetoed`. `Attribution.spans` counts SPANS, and the
 * two differ whenever coalescence merges two clauses into one marker.
 *
 * **`dense` is always zero from `attributeLexical`**, because that door does
 * not run the rung, and the clauses it would have decided land in
 * `unattributed` instead. The two doors are two instruments: a counter from
 * one compared against the other compares different measurements of
 * different work.
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
     * list, and it is by being the complete inventory that the number means the
     * same thing to two callers holding the same results. Trimming it to "only
     * what was cited" would move every number.
     */
    readonly sources: readonly SearchResult[];
    readonly rungs: RungCounts;
}

export interface AttributeOptions {
    /**
     * The SAME tokenizer that indexed the corpus.
     *
     * Attributing with a different one is not detectable from inside this
     * function: it receives `SearchResult[]`, and a result carries no tokenizer
     * id. The caller holds both halves and can check in one line —
     * `index.tokenizerId === tokenizer.id` — which is why the id is public on
     * `Index`. Construct the tokenizer once and pass it to both:
     *
     *     const tokenizer = createTokenizer();
     *     const index = createIndex(docs, { tokenizer });
     *     const a = attributeLexical(text, results, { tokenizer });
     *
     * `createIndex` defaults the tokenizer when none is given and does not hand
     * back what it built, so the short path leaves no handle to attribute with.
     */
    readonly tokenizer: Tokenizer;
    /** The same sentence boundary the chunker cut on. */
    readonly segmenter?: Segmenter;
    readonly abbreviations?: AbbreviationList;
    /**
     * Absent, only the two local rungs run and `attribute` answers exactly
     * what `attributeLexical` answers. Present, the clauses the words cannot
     * separate are decided by the vectors, at the cost of two network calls.
     */
    readonly provider?: EmbeddingProvider;
    /** See `DEFAULT_COALESCE_MAX_CODE_POINTS`. */
    readonly coalesceMaxCodePoints?: number;
    /** See `DEFAULT_MIN_CLUSTER_CODE_POINTS`. Zero turns the floor off. */
    readonly minClusterCodePoints?: number;
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

/**
 * Negation markers, folded the way the tokenizer folds them.
 *
 * Measured against `createTokenizer()` rather than written from the spelling:
 * `não` arrives as `nao` and `ninguém` as `ninguem`. A list written the way the
 * words are spelled would match nothing, and veto nothing, in silence.
 */
export const NEGATION_MARKERS: ReadonlySet<string> = new Set([
    'nao',
    'nunca',
    'jamais',
    'nenhum',
    'nenhuma',
    'ninguem',
    'nada',
    'nem',
    'sem',
]);

/** Why the veto rejected a candidate. It never says which one to cite. */
export type VetoReason = 'numeral' | 'negation';

/**
 * The terms that carry a number, which the tokenizer keeps whole: `8.078/90`,
 * `2026-09-09` and `12:30` arrive as one term each, so a legal reference, an
 * ISO date and a clock time are checked as the single facts they are rather
 * than as loose digits.
 */
export function numeralsOf(terms: ReadonlySet<string>): ReadonlySet<string> {
    const out = new Set<string>();
    for (const term of terms) if (/\d/u.test(term)) out.add(term);
    return out;
}

/** A sentence of a candidate passage, located in the SOURCE DOCUMENT. */
export interface MatchedSentence {
    readonly span: Span;
    readonly terms: ReadonlySet<string>;
}

/**
 * The sentence of a passage that best carries a clause, in document
 * coordinates.
 *
 * Computed per CANDIDATE and on demand, not for the winner after the fact:
 * the veto needs it to judge a candidate, and the veto runs before anything is
 * chosen. Deriving it from the winner would need a winner to exist first, which
 * is the circle this ordering exists to avoid.
 *
 * The offsets are the document's, not the chunk's — `chunk.text` is cut from
 * the source, so the chunk's own start is all that has to be added.
 *
 * KNOWN LIMIT, inherited from segmenting a fragment: a protected region that
 * crosses the chunk's edge masks differently here than in the whole document,
 * because half of a fenced block has no fence (`tokenizer.ts`). Two chunks that
 * overlap on the same sentence can therefore bound it differently, and the
 * popover can open on a passage cut inside a URL or a formula.
 */
export function matchedSentenceOf(
    clause: Clause,
    chunk: { readonly text: string; readonly span: Span },
    df: ReadonlyMap<string, number>,
    candidateCount: number,
    opts: AttributeOptions,
): MatchedSentence | null {
    const segmenter = opts.segmenter ?? defaultSegmenter();
    let best: MatchedSentence | null = null;
    let bestWeight = 0;
    for (const local of sentencesOf(chunk.text, segmenter, opts.abbreviations)) {
        const text = chunk.text.slice(...utf16Range(chunk.text, local));
        const terms = distinctTerms(text, opts.tokenizer);
        let weight = 0;
        for (const term of clause.terms) {
            if (terms.has(term)) weight += separationWeight(df.get(term) ?? 0, candidateCount);
        }
        if (weight > bestWeight) {
            bestWeight = weight;
            best = {
                span: { start: chunk.span.start + local.start, end: chunk.span.start + local.end },
                terms,
            };
        }
    }
    return best;
}

/**
 * Whether a candidate is ineligible for this clause. It only ever rejects.
 *
 * A rejected candidate cannot be cited by ANY rung for this clause — that is
 * the whole point. Sending a vetoed passage down to the dense rung without
 * removing it from the pool would let the vectors re-elect it, and the veto
 * would be decoration: the vetoed candidate is the lexical winner, so it is
 * usually the nearest by cosine too.
 *
 * Rejecting is not choosing. Whoever wins among the survivors still wins by
 * the rung's own criterion, and the runner-up is never promoted by elimination.
 *
 * The two rules check against DIFFERENT scopes, and the asymmetry is
 * deliberate:
 *
 *   numeral    against the WHOLE passage. A figure cited three sentences later
 *              still supports the clause that mentions it.
 *   negation   against the MATCHED SENTENCE. A passage that says "X is allowed"
 *              and, further down, "Y is not allowed" contains a negation
 *              marker; checking the whole passage would fire against the
 *              positive clause about X, which it supports perfectly.
 *
 * False veto is the one direction a veto must not err in. It exists to drop
 * what is not supported, and dropping what IS supported loses a correct
 * citation with nothing to show for it.
 *
 * DECLARED LIMIT: negation without a lexical marker — "deixou de", "está longe
 * de" — does not fire, and the citation passes. That is the safe direction, and
 * reinforcing negation ("não vi ninguém") puts markers on both sides rather
 * than producing a false veto.
 */
export function vetoes(
    clause: Clause,
    candidateTerms: ReadonlySet<string>,
    matched: MatchedSentence | null,
): VetoReason | null {
    for (const numeral of numeralsOf(clause.terms)) {
        if (!candidateTerms.has(numeral)) return 'numeral';
    }
    const clauseNegated = hasNegation(clause.terms);
    const passageNegated = matched ? hasNegation(matched.terms) : false;
    if (clauseNegated !== passageNegated) return 'negation';
    return null;
}

function hasNegation(terms: ReadonlySet<string>): boolean {
    for (const term of terms) if (NEGATION_MARKERS.has(term)) return true;
    return false;
}

/**
 * How far the sentence sits from the nearer edge of the chunk that carries it.
 *
 * Two subtractions and a minimum. The number is only ever compared against
 * another chunk's, so its scale means nothing on its own.
 */
export function centrality(sentence: Span, chunk: Span): number {
    return Math.min(sentence.start - chunk.start, chunk.end - sentence.end);
}

/**
 * Which chunk a citation names when several carry the very same sentence.
 *
 * The chunker overlaps on purpose, in whole sentences, so a sentence on a seam
 * lives at the END of one chunk and at the START of the next. Both carry it,
 * both support the clause equally, and one has to be named.
 *
 * > The chunk in which the cited sentence sits FURTHEST from an edge wins.
 * > Ties go to the chunk with MORE TEXT AFTER the sentence, and then to the
 * > lower starting offset, which is total and deterministic.
 *
 * "Lowest offset" would have been cheaper and is wrong: on a seam the sentence
 * is pinned to the END of the earlier chunk, so that rule picks the view where
 * the reader opens the popover on the cited line with nothing after it — every
 * time, and by what is cheap to compute rather than by what serves reading.
 * Centrality costs two subtractions.
 *
 * **The middle tie-break is load-bearing, and centrality alone is not enough.**
 * On a true seam the sentence ends the earlier chunk AND opens the later one,
 * so it is pinned to an edge in BOTH and centrality is zero on both sides:
 *
 *     sentence 180..200,  chunk N = 0..200,  chunk N+1 = 180..400
 *     N    before 180, after   0  ->  min 0
 *     N+1  before   0, after 200  ->  min 0
 *
 * Breaking that tie by the lower offset would name N — the view with nothing
 * after the cited line, which is the one this rule exists to refuse. Comparing
 * the text that FOLLOWS the sentence names N+1, and that is what the reader
 * gets: the citation plus what comes next. Centrality still decides every case
 * where the sentence is inside both chunks rather than on their boundary, which
 * is why it stays first.
 *
 * This is ONLY for the seam: the same sentence, at the same document offsets,
 * in more than one chunk. A fact stated twice in a document — once in the
 * introduction, once in the conclusion — is two independent occurrences at
 * different offsets, and merging them would hide from the reader that the
 * source says it twice, which is usually the more interesting fact.
 *
 * What the choice decides is what the reader sees AROUND the citation, and how
 * stable the identifier is between runs. It is NOT what keeps the chip from
 * duplicating: one span carries one `chunkId`, so there is no path from "the
 * sentence is in two chunks" to "two chips" for the contract to worry about.
 */
export function chooseChunkForSeam<T extends { readonly span: Span }>(
    sentence: Span,
    candidates: readonly T[],
    fallback: T,
): T {
    let best: T | null = null;
    for (const candidate of candidates) {
        if (candidate.span.start > sentence.start || candidate.span.end < sentence.end) continue;
        if (best === null || beatsForSeam(sentence, candidate.span, best.span)) best = candidate;
    }
    return best ?? fallback;
}

/** The three comparisons of the seam rule, in order, so the order is visible. */
function beatsForSeam(sentence: Span, challenger: Span, holder: Span): boolean {
    const byCentrality = centrality(sentence, challenger) - centrality(sentence, holder);
    if (byCentrality !== 0) return byCentrality > 0;
    const byTextAfter = challenger.end - holder.end;
    if (byTextAfter !== 0) return byTextAfter > 0;
    return challenger.start < holder.start;
}

/**
 * Two citations of the same passage closer than this fuse into one marker, so
 * the reader does not get two numbers stuck to the same idea.
 *
 * ARBITRARY UNTIL MEASURED, in the same regime as the two thresholds above.
 */
export const DEFAULT_COALESCE_MAX_CODE_POINTS = 80;

/**
 * No anchor is emitted closer than this to the previous one; it is deferred to
 * the next clause instead. Short sentences from different passages otherwise
 * turn the text into a washing line of chips.
 *
 * ZERO turns the floor off and puts an anchor on every clause, with no room to
 * breathe. That is illegible as prose and is exactly what a line-by-line audit
 * needs — every claim with its support beside it, with nothing grouped on the
 * reader's behalf — which is the only reason the option is public.
 *
 * ARBITRARY UNTIL MEASURED.
 */
export const DEFAULT_MIN_CLUSTER_CODE_POINTS = 70;

/** A span on its way through the density rules, with what they need to decide. */
export interface Placed {
    readonly span: AttributionSpan;
    /** Position in the clause sequence. Adjacency is measured here, not on spans. */
    readonly firstClause: number;
    readonly lastClause: number;
    /** The union of the terms of every clause this span covers. */
    readonly terms: ReadonlySet<string>;
    /** Whether the floor already moved this anchor. */
    readonly moved: boolean;
    /** Whether it already took part in a fusion, in either pass. */
    readonly fused: boolean;
}

/**
 * Fuses neighbouring citations of the same passage.
 *
 * **Adjacency is measured over CLAUSES, not over spans.** The two doors produce
 * different span lists for the same text — `attributeLexical` has no span for a
 * clause only the vectors can resolve — so a rule reading span neighbours would
 * fuse a pair for one caller and not for the other. The clause sequence is
 * identical for both, because segmentation is deterministic: the lexical door
 * KNOWS the clause in between exists, it just has no span for it.
 *
 * Skipping over that clause would be worse than a mode difference. `Span` is a
 * contiguous range, so fusing across it produces a `textSpan` that CONTAINS the
 * clause in the middle — a marker claiming support over a stretch its passage
 * does not support, which is the failure this package is named for.
 *
 * It does not chain: a fused span is closed and cannot fuse again, here or in
 * the second pass. Chaining would let a span grow across a whole run of near
 * clauses with no ceiling, and then nothing could be called final until the run
 * ended — which is the bounded delay the streaming mode depends on.
 */
export function coalescePass(
    items: readonly Placed[],
    eligible: (a: Placed, b: Placed) => boolean,
    recompute: (terms: ReadonlySet<string>, chunkId: string) => number,
    maxDistance: number,
): Placed[] {
    const out: Placed[] = [];
    let i = 0;
    while (i < items.length) {
        const a = items[i]!;
        const b = items[i + 1];
        if (
            b !== undefined &&
            !a.fused &&
            !b.fused &&
            a.span.chunkId === b.span.chunkId &&
            a.span.resolvedBy === 'lexical' &&
            b.span.resolvedBy === 'lexical' &&
            b.firstClause === a.lastClause + 1 &&
            b.span.anchorOffset - a.span.anchorOffset <= maxDistance &&
            eligible(a, b)
        ) {
            const terms = new Set([...a.terms, ...b.terms]);
            out.push({
                span: {
                    textSpan: { start: a.span.textSpan.start, end: b.span.textSpan.end },
                    // The anchor moves to the later resting place; the spans do not.
                    anchorOffset: b.span.anchorOffset,
                    sourceSpan: {
                        start: Math.min(a.span.sourceSpan.start, b.span.sourceSpan.start),
                        end: Math.max(a.span.sourceSpan.end, b.span.sourceSpan.end),
                    },
                    chunkId: a.span.chunkId,
                    documentId: a.span.documentId,
                    // Recomputed over the UNION, never chosen between the two:
                    // `confidence` is published as a fraction of the clause's
                    // weight, and the minimum of two fractions is a fraction of
                    // nothing.
                    confidence: recompute(terms, a.span.chunkId),
                    resolvedBy: 'lexical',
                },
                firstClause: a.firstClause,
                lastClause: b.lastClause,
                terms,
                moved: a.moved || b.moved,
                fused: true,
            });
            i += 2;
            continue;
        }
        out.push(a);
        i += 1;
    }
    return out;
}

/**
 * Defers an anchor that would land too close to the previous one.
 *
 * The anchor moves; the span does not. `textSpan` keeps pointing at the clause
 * that is actually supported, because making the span follow the anchor would
 * open the popover on the wrong sentence.
 *
 * **On the last clause the floor gives way and the anchor stays where it is.**
 * There is no next clause to defer to, and the two readings of "not emitted"
 * differ in something the reader sees: leaving it in place breaks the floor on
 * one anchor, and suppressing it makes the last citation of every short answer
 * disappear without a symptom. The floor is a legibility heuristic; losing a
 * citation is a loss of correctness, and in a library whose whole argument is
 * auditability the second is not a trade. This is the ONLY place the floor is
 * broken by design.
 */
export function applyFloor(
    items: readonly Placed[],
    clauseEnds: readonly number[],
    minCluster: number,
): Placed[] {
    if (minCluster <= 0) return [...items];
    const out: Placed[] = [];
    let previousAnchor: number | null = null;
    for (const item of items) {
        const anchor = item.span.anchorOffset;
        const tooClose = previousAnchor !== null && anchor - previousAnchor < minCluster;
        const next = clauseEnds[item.lastClause + 1];
        if (tooClose && next !== undefined) {
            out.push({ ...item, span: { ...item.span, anchorOffset: next }, moved: true });
            previousAnchor = next;
            continue;
        }
        out.push(item);
        previousAnchor = anchor;
    }
    return out;
}

/**
 * The three density passes, in the order that matters.
 *
 * > coalescence, then the floor, then coalescence again over what the floor
 * > moved.
 *
 * The two rules do not commute, and the order is not a detail. Three clauses of
 * the same passage anchored at 0, 40 and 100, with the defaults:
 *
 *     floor first   40 is deferred (40 < 70); {0, 100} remain; 100 apart, no
 *                   fusion -> TWO chips
 *     fusion first  0 and 40 fuse; the result and 100 are 60 apart -> ONE chip
 *
 * Same input, different output on the page. Fusing first is the order that
 * serves the reader: reduce what is the same source BEFORE spacing what is
 * left, because spacing first defers an anchor that would have disappeared in
 * the fusion and produces two chips where one was enough.
 *
 * The third pass exists because the floor can CREATE what the fusion just
 * prevented. Everything of the same passage within the fusion window is already
 * merged, so any surviving pair of that passage is further apart than the
 * window — and those are exactly the pairs the floor defers, landing them next
 * to each other again. The second pass sees only anchors the floor moved, and
 * it terminates for a reason that does not depend on who it sees: fusing
 * CHOOSES between existing anchors and never creates a position, so after it
 * nothing has moved and there is nothing for a fourth pass to find.
 */
export function applyDensity(
    items: readonly Placed[],
    clauseEnds: readonly number[],
    recompute: (terms: ReadonlySet<string>, chunkId: string) => number,
    opts: { readonly coalesceMaxCodePoints?: number; readonly minClusterCodePoints?: number } = {},
): readonly AttributionSpan[] {
    const coalesce = opts.coalesceMaxCodePoints ?? DEFAULT_COALESCE_MAX_CODE_POINTS;
    const floor = opts.minClusterCodePoints ?? DEFAULT_MIN_CLUSTER_CODE_POINTS;

    const fused = coalescePass(items, () => true, recompute, coalesce);
    const spaced = applyFloor(fused, clauseEnds, floor);
    const settled = coalescePass(spaced, (a, b) => a.moved && b.moved, recompute, coalesce);
    return settled.map((item) => item.span);
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

/**
 * The tunable half of `AttributeOptions`, with the injected half omitted.
 *
 * `tokenizer` cannot have a default — a library that picked one would decide
 * for the caller which terms the corpus was indexed with — and neither can the
 * segmenter or the abbreviation list, for the same reason. So the default is
 * the options MINUS what has to be injected, which is the shape
 * `DEFAULT_CHUNK_OPTIONS` already uses for the same reason.
 */
export const DEFAULT_ATTRIBUTE_OPTIONS: Readonly<
    Omit<AttributeOptions, 'tokenizer' | 'provider' | 'segmenter' | 'abbreviations'>
> = {
    coalesceMaxCodePoints: DEFAULT_COALESCE_MAX_CODE_POINTS,
    minClusterCodePoints: DEFAULT_MIN_CLUSTER_CODE_POINTS,
};

/** A clause the local rungs could not settle, with what the next rung needs. */
interface Pending {
    readonly clause: Clause;
    readonly clauseIndex: number;
    /**
     * Candidates the veto rejected. No rung may cite one of these.
     *
     * NON-EMPTY MEANS THE VETO ALREADY FIRED FOR THIS CLAUSE, and the dense
     * rung reads it that way so `rungs.vetoed` counts the clause once however
     * many candidates the veto goes on to reject. Seed this set for any other
     * reason — a pre-filter, a candidate from the wrong document — and that
     * counter undercounts in silence.
     */
    readonly ineligible: ReadonlySet<number>;
}

/** Everything the two doors share, computed once and without a network. */
interface Prepared {
    readonly clauses: readonly Clause[];
    readonly candidateTerms: readonly ReadonlySet<string>[];
    readonly df: ReadonlyMap<string, number>;
    readonly termsByChunk: ReadonlyMap<string, ReadonlySet<string>>;
    readonly placed: Placed[];
    readonly pending: Pending[];
    vetoed: number;
}

/**
 * The local half of the pipeline, in the order that has no circle in it.
 *
 *   1  the lexical rung ranks the candidates
 *   2  the MATCHED SENTENCE of the candidate under judgement is computed
 *   3  the veto judges (clause, candidate) using that sentence; a rejected
 *      candidate is ineligible for this clause in EVERY rung
 *   4  the seam re-chooses among chunks carrying the very same sentence
 *   5  the source span is that sentence, in document coordinates
 *
 * Step 2 sits before step 3 because the veto needs it, and after nothing:
 * deriving it from the winner would need a winner to exist first.
 *
 * A clause the rungs here cannot settle becomes `Pending` and carries its own
 * set of rejected candidates with it. That set is why the veto is not
 * decoration: the vetoed candidate is the lexical winner, so it is usually the
 * nearest by cosine too, and a rung that did not know it was rejected would
 * re-elect it.
 */
function prepare(text: string, results: readonly SearchResult[], opts: AttributeOptions): Prepared {
    const clauses = clausesOf(text, opts);
    const candidateTerms = results.map((r) => distinctTerms(r.chunk.text, opts.tokenizer));
    const df = candidateFrequencies(candidateTerms);
    const termsByChunk = new Map<string, ReadonlySet<string>>();
    results.forEach((r, i) => termsByChunk.set(r.chunk.id, candidateTerms[i]!));

    const placed: Placed[] = [];
    const pending: Pending[] = [];
    let vetoed = 0;

    clauses.forEach((clause, clauseIndex) => {
        const outcome = lexicalRung(clause, candidateTerms, df);
        if (outcome.kind === 'unattributable') return;
        if (outcome.kind === 'tied') {
            pending.push({ clause, clauseIndex, ineligible: new Set() });
            return;
        }

        const winner = results[outcome.index]!;
        const matched = matchedSentenceOf(clause, winner.chunk, df, results.length, opts);
        if (vetoes(clause, candidateTerms[outcome.index]!, matched) !== null) {
            vetoed += 1;
            // Down a rung, never sideways: promoting the runner-up would make
            // the veto choose, and the only thing the veto does is reject.
            pending.push({ clause, clauseIndex, ineligible: new Set([outcome.index]) });
            return;
        }

        placed.push(
            place(clause, clauseIndex, results, outcome.index, matched, outcome.confidence, 'lexical'),
        );
    });

    return { clauses, candidateTerms, df, termsByChunk, placed, pending, vetoed };
}

/** Builds the span for a decided clause, including the seam re-choice. */
function place(
    clause: Clause,
    clauseIndex: number,
    results: readonly SearchResult[],
    winnerIndex: number,
    matched: MatchedSentence | null,
    confidence: number,
    resolvedBy: ResolvedBy,
): Placed {
    const winner = results[winnerIndex]!;
    const chosen = matched
        ? chooseChunkForSeam(
              matched.span,
              results.map((r) => r.chunk).filter((c) => c.documentId === winner.chunk.documentId),
              winner.chunk,
          )
        : winner.chunk;
    return {
        span: {
            textSpan: clause.span,
            anchorOffset: clause.span.end,
            sourceSpan: matched ? matched.span : chosen.span,
            chunkId: chosen.id,
            documentId: chosen.documentId,
            confidence,
            resolvedBy,
        },
        firstClause: clauseIndex,
        lastClause: clauseIndex,
        terms: clause.terms,
        moved: false,
        fused: false,
    };
}

/** Assembles the envelope once the rungs have had their say. */
function finish(
    text: string,
    results: readonly SearchResult[],
    prepared: Prepared,
    opts: AttributeOptions,
    counts: { lexical: number; dense: number; unattributed: number },
): Attribution {
    const ordered = [...prepared.placed].sort((a, b) => a.firstClause - b.firstClause);
    const spans = applyDensity(
        ordered,
        prepared.clauses.map((c) => c.span.end),
        (terms, chunkId) =>
            coverageOf(
                terms,
                prepared.termsByChunk.get(chunkId) ?? new Set<string>(),
                prepared.df,
                results.length,
            ) ?? 0,
        opts,
    );
    return { text, spans, sources: results, rungs: { ...counts, vetoed: prepared.vetoed } };
}

/**
 * Attribution without a key: the two local rungs, and nothing that touches the
 * network.
 *
 * This is the whole of what works in a browser with no API key, and the
 * consequence is worth saying rather than leaving to be discovered: a clause
 * the words cannot separate comes back with NO chip here, where the dense rung
 * would have decided it. Coverage in this mode is structurally lower than any
 * figure measured with a provider, and a number published for one does not hold
 * for the other.
 */
export function attributeLexical(
    text: string,
    results: readonly SearchResult[],
    opts: AttributeOptions,
): Attribution {
    const prepared = prepare(text, results, opts);
    return finish(text, results, prepared, opts, {
        lexical: prepared.placed.length,
        dense: 0,
        unattributed: prepared.clauses.length - prepared.placed.length,
    });
}

/**
 * The full ladder. Without `opts.provider` it answers exactly what
 * `attributeLexical` answers, and pays nothing.
 *
 * **Two network calls, however many clauses are ambiguous.** One embeds the
 * candidate passages, one embeds every unresolved clause together. Embedding a
 * clause at a time would be one call per sentence, which is the cost that made
 * the ladder necessary in the first place: a ladder whose last rung costs what
 * skipping the ladder costs is not a ladder.
 *
 * Both sides go through `embedDocuments`, never `embedQuery`. A clause of an
 * answer is declarative text compared against declarative text; it is not a
 * question looking for a passage, which is the asymmetry the other door exists
 * for. Different doors would put the two sides in spaces with different task
 * prefixes, and the cosine would measure the prefix.
 *
 * The candidates are re-embedded rather than read out of the index. It pays
 * again for vectors the index already holds, and in exchange both sides of
 * every comparison are born in the same call, from the same provider, through
 * the same door: there is no path here for a vector from an old artifact to be
 * compared against a fresh one.
 */
export async function attribute(
    text: string,
    results: readonly SearchResult[],
    opts: AttributeOptions,
): Promise<Attribution> {
    const prepared = prepare(text, results, opts);
    const provider = opts.provider;
    if (provider === undefined || prepared.pending.length === 0) {
        return finish(text, results, prepared, opts, {
            lexical: prepared.placed.length,
            dense: 0,
            unattributed: prepared.clauses.length - prepared.placed.length,
        });
    }

    const passages = results.map((r) => r.chunk.text);
    const clauseTexts = prepared.pending.map((p) =>
        sliceCodePoints(text, p.clause.span.start, p.clause.span.end),
    );

    // The window guard runs on BOTH lists. A clause is not safe for being
    // short: the chunker never splits a sentence, so a long period of quoted
    // statute is one clause, over the ceiling, and the text a model writes has
    // the same freedom.
    assertChunksFit(
        results.map((r) => ({ id: r.chunk.id, text: r.chunk.text })),
        provider,
    );
    assertChunksFit(
        clauseTexts.map((t, i) => ({ id: `clause ${prepared.pending[i]!.clauseIndex}`, text: t })),
        provider,
    );

    const passageVectors = await embedDocumentsChecked(passages, provider);
    const clauseVectors = await embedDocumentsChecked(clauseTexts, provider);

    let dense = 0;
    prepared.pending.forEach((item, i) => {
        // The veto keeps rejecting and the rung keeps choosing among what is
        // left, which is what makes the ineligible set load-bearing rather than
        // a second opinion: it is how the loop narrows, and how it ends. A rung
        // that dropped the clause on the first rejection would lose a citation
        // that another passage could have carried.
        const ineligible = new Set(item.ineligible);
        // Already counted upstream when the lexical winner was rejected.
        let countedVeto = item.ineligible.size > 0;
        let chosen: number | null = null;
        let matched: MatchedSentence | null = null;
        for (;;) {
            chosen = denseRung(clauseVectors[i]!, passageVectors, ineligible);
            if (chosen === null) break;
            matched = matchedSentenceOf(
                item.clause,
                results[chosen]!.chunk,
                prepared.df,
                results.length,
                opts,
            );
            if (vetoes(item.clause, prepared.candidateTerms[chosen]!, matched) === null) break;
            // The COUNTER marks the clause, once, however many candidates the
            // veto goes on to reject for it. The ineligible set is what keeps
            // the loop narrowing; counting here as well would publish more
            // veto events than there are clauses, and the ruler divides this
            // by clauses examined.
            if (!countedVeto) {
                prepared.vetoed += 1;
                countedVeto = true;
            }
            ineligible.add(chosen);
        }
        if (chosen === null) return;
        dense += 1;
        const confidence =
            coverageOf(
                item.clause.terms,
                prepared.candidateTerms[chosen]!,
                prepared.df,
                results.length,
            ) ?? 0;
        prepared.placed.push(
            place(item.clause, item.clauseIndex, results, chosen, matched, confidence, 'dense'),
        );
    });

    return finish(text, results, prepared, opts, {
        lexical: prepared.placed.length - dense,
        dense,
        unattributed: prepared.clauses.length - prepared.placed.length,
    });
}

/**
 * Picks the nearest eligible passage by cosine, or nothing.
 *
 * **Non-positive cosines are dropped before the margin is applied**, and the
 * reason is the sign rather than the size. In cosine, non-positive means a
 * passage pointing AWAY from the clause, orthogonal or opposite, which is worse
 * than absent. And `LEXICAL_MARGIN` is MULTIPLICATIVE, so it inverts over
 * negatives: with -0.10 and -0.50 the comparison passes, and the clause would
 * take a chip pointing at the passage that points furthest away from it. A
 * multiplicative margin over a signed quantity is a ruler in the wrong unit.
 */
function denseRung(
    clauseVector: readonly number[],
    passageVectors: readonly (readonly number[])[],
    ineligible: ReadonlySet<number>,
): number | null {
    // Seeded below every possible cosine rather than at zero, so the guard
    // below is the thing that excludes a passage pointing away — not an
    // accident of the initial value. A seed of zero would do the same job
    // silently, and a later reader removing the guard would see no test fail.
    let best = -1;
    let bestScore = -Infinity;
    let runnerUp = -Infinity;
    passageVectors.forEach((vector, index) => {
        if (ineligible.has(index)) return;
        const score = dot([...clauseVector], [...vector]);
        if (score <= 0) return;
        if (score > bestScore) {
            runnerUp = bestScore;
            bestScore = score;
            best = index;
        } else if (score > runnerUp) {
            runnerUp = score;
        }
    });
    if (best < 0) return null;
    if (runnerUp > 0 && bestScore < LEXICAL_MARGIN * runnerUp) return null;
    return best;
}

/** Slices in code points, which is the unit of every offset in this package. */
function sliceCodePoints(text: string, start: number, end: number): string {
    return Array.from(text).slice(start, end).join('');
}
