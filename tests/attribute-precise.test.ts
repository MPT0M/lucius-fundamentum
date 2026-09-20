import { describe, it, expect } from 'vitest';
import {
    attributeLexical,
    createIndex,
    createTokenizer,
    type SourceDoc,
    type SearchResult,
} from '../src/index.js';
import { applyDensity, type Placed } from '../src/attribute.js';

const tokenizer = createTokenizer();

/**
 * A span built by hand, so that the two predicates can be told apart.
 *
 * `chunkId` and `sourceSpan` move together on purpose: that is the invariant
 * `place` maintains, and the reason two raw spans of one chunk are lossless to
 * fuse.
 */
const span = (clause: number, anchor: number, precise: boolean, source: [number, number]): Placed => ({
    span: {
        textSpan: { start: anchor - 15, end: anchor },
        anchorOffset: anchor,
        sourceSpan: { start: source[0], end: source[1] },
        chunkId: 'lei#2',
        documentId: 'lei',
        confidence: 0.5,
        resolvedBy: 'lexical',
    },
    firstClause: clause,
    lastClause: clause,
    terms: new Set([`t${clause}`]),
    moved: false,
    fused: false,
    precise,
});

const OPTS = { coalesceMaxCodePoints: 80, minClusterCodePoints: 0 };
const ENDS = [20, 45, 200];

describe('fusion requires the two sides to AGREE about precision', () => {
    it('two RAW spans of one chunk still fuse, because nothing inflates', () => {
        // TARGET OF THE REVERSAL: `a.precise && b.precise` instead of `===`.
        // Under `&&` this pair stops fusing and prints two markers with the
        // same chunkId AND the same sourceSpan, which the formatter does not
        // merge — it dedupes by (anchorOffset, chunkId) and the anchors differ.
        // Two numbers glued to one idea, produced by the rule that came to
        // protect precision.
        const raw: [number, number] = [0, 1200];
        const out = applyDensity(
            [span(0, 20, false, raw), span(1, 45, false, raw)],
            ENDS,
            () => 0.5,
            OPTS,
        );
        expect(out).toHaveLength(1);
        // And the fused sourceSpan is the same interval, not a wider one: the
        // min/max of two identical ranges moves nothing.
        expect(out[0]!.sourceSpan).toEqual({ start: 0, end: 1200 });
    });

    it('two PRECISE spans fuse, as they always did', () => {
        const out = applyDensity(
            [span(0, 20, true, [10, 70]), span(1, 45, true, [80, 140])],
            ENDS,
            () => 0.5,
            OPTS,
        );
        expect(out).toHaveLength(1);
    });

    it('a raw span and a precise one do NOT fuse, and that is the whole point', () => {
        // TARGET OF THE REVERSAL: remove the condition entirely. The surgical
        // claim then inflates to the block — the popover that opened on one
        // sentence opens on the paragraph.
        const out = applyDensity(
            [span(0, 20, true, [10, 70]), span(1, 45, false, [0, 1200])],
            ENDS,
            () => 0.5,
            OPTS,
        );
        expect(out).toHaveLength(2);
        // The precise one kept its sentence.
        expect(out[0]!.sourceSpan).toEqual({ start: 10, end: 70 });
    });
});

describe('the predicate is blind to the rung, and the LEXICAL case is real', () => {
    // The plan justified `precise` by the dense case — paraphrase with no
    // shared term. But `matched !== null` knows nothing about rungs, and a
    // LEXICAL winner reaches it too: the rung elects by `coverageOf`, weighted
    // with `sustainWeight` (always positive), while `matchedSentenceOf` weighs
    // with `separationWeight` and needs a strictly positive total. Two rulers.
    //
    // A fixture only for the dense case would prove the rule over half the
    // population and stay silent about the half where today's behaviour
    // changes.
    const VOCAB = ['prazo', 'recurso', 'dias', 'contagem', 'relator', 'agravo', 'pericia', 'parte'];
    const frase = (n: number) => VOCAB.slice(n % 4, (n % 4) + 3).join(' ') + '. ';

    it('a lexical span can carry the whole chunk as its sourceSpan', () => {
        let text = '';
        for (let i = 0; i < 40; i += 1) text += frase(i);
        const doc: SourceDoc = { id: 'd', text };
        const index = createIndex([doc], {
            tokenizer,
            chunkOptions: { maxChunkCodePoints: 80, maxOverlapCodePoints: 40 },
        });
        const results: readonly SearchResult[] = index.searchLexical(VOCAB.join(' '), { topK: 10 });
        const byId = new Map(results.map((r) => [r.chunk.id, r.chunk]));

        const out = attributeLexical(frase(0) + frase(1), results, { tokenizer });
        const lexicalRaw = out.spans.filter((s) => {
            const chunk = byId.get(s.chunkId);
            if (!chunk || s.resolvedBy !== 'lexical') return false;
            // The control that the first version of this measurement lacked: a
            // chunk holding ONE sentence has that sentence equal to itself, and
            // the signal would be false. Only chunks with two or more count.
            const sentences = (chunk.text.match(/[.!?](\s|$)/g) ?? []).length;
            return (
                sentences >= 2 &&
                s.sourceSpan.start === chunk.span.start &&
                s.sourceSpan.end === chunk.span.end
            );
        });

        expect(lexicalRaw.length).toBeGreaterThan(0);
    });
});
