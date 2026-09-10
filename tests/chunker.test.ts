import { describe, it, expect } from 'vitest';
import { chunk, DEFAULT_CHUNK_OPTIONS, type SourceDoc, type ChunkOptions } from '../src/chunker.js';
import { MASK_CHAR } from '../src/math.js';
import { countCodePoints, sliceByCodePoints } from '../src/unicode.js';

function doc(text: string, extra: Partial<SourceDoc> = {}): SourceDoc {
    return { id: 'd1', title: 'Doc', text, ...extra };
}

/**
 * A tiny budget so a handful of sentences produce several chunks. Every PROSE
 * sentence is under 30 code points, so two fit in a chunk of 60 and one fits
 * in the overlap of 30 — which is what makes the overlap observable.
 */
const SMALL: ChunkOptions = { maxChunkCodePoints: 60, maxOverlapCodePoints: 30 };

const PROSE =
    'A primeira frase é curta. A segunda é outra. ' +
    'A terceira volta ao tema. A quarta segue adiante. ' +
    'A quinta quase encerra. A sexta encerra o texto.';

describe('chunk — every chunk knows exactly where it came from', () => {
    it('text is cut from the ORIGINAL at the span, never from a masked copy', () => {
        const d = doc(PROSE);
        for (const c of chunk(d, SMALL)) {
            expect(c.text).toBe(sliceByCodePoints(d.text, c.span.start, c.span.end));
        }
    });

    it('no mask character ever escapes into a chunk', () => {
        // The reason Chunk.text is cut from the original: a chunk cut from the
        // masked text would render U+E000 where the formula was, and the
        // lexical index would find nothing of it.
        const d = doc('Considere $x = 1.5$ como base. Depois some $$\\int_0^1 f$$ ao total. Fim.');
        const out = chunk(d, SMALL);
        expect(out.length).toBeGreaterThan(0);
        for (const c of out) expect(c.text).not.toContain(MASK_CHAR);
        expect(out.map((c) => c.text).join(' ')).toContain('$x = 1.5$');
    });

    it('ids are stable and ordinal', () => {
        const ids = chunk(doc(PROSE), SMALL).map((c) => c.id);
        expect(ids).toEqual(ids.map((_, i) => `d1#${i}`));
    });

    it('carries the page number when the source has one, and omits it otherwise', () => {
        const paged = chunk(doc('Uma frase só.', { pageNumber: 7 }), SMALL);
        expect(paged[0]!.pageNumber).toBe(7);
        const pasted = chunk(doc('Uma frase só.'), SMALL);
        expect('pageNumber' in pasted[0]!).toBe(false);
    });
});

describe('chunk — boundaries fall on sentences, never inside one', () => {
    it('never splits a formula, even one with a period inside it', () => {
        const d = doc('Vale $x = 1.5$ aqui. Outra frase depois.');
        const out = chunk(d, { maxChunkCodePoints: 25, maxOverlapCodePoints: 0 });
        // Whatever the cut, the formula lands whole inside exactly one chunk.
        const holders = out.filter((c) => c.text.includes('$x = 1.5$'));
        expect(holders).toHaveLength(1);
        for (const c of out) {
            const dollars = (c.text.match(/\$/g) ?? []).length;
            expect(dollars % 2).toBe(0); // no chunk holds half a formula
        }
    });

    it('never splits a formula that LOOKS like a sentence boundary inside', () => {
        // `$A. B$` is period, space, capital — exactly what a segmenter calls a
        // sentence end. Without the mask this splits into `$A.` and `B$ dado.`
        // and two chunks each hold half a formula. This is the case the
        // mutation "chunk without masking" is caught by.
        const d = doc('Seja $A. B$ dado. Fim.');
        const out = chunk(d, { maxChunkCodePoints: 12, maxOverlapCodePoints: 0 });
        for (const c of out) {
            const dollars = (c.text.match(/\$/g) ?? []).length;
            expect(dollars % 2, `half a formula in ${JSON.stringify(c.text)}`).toBe(0);
        }
        expect(out.some((c) => c.text.includes('$A. B$'))).toBe(true);
    });

    it('a sentence longer than the budget becomes a chunk on its own, uncut', () => {
        const longSentence = 'Esta frase é deliberadamente comprida e ultrapassa o orçamento do chunk sem terminar.';
        expect(countCodePoints(longSentence)).toBeGreaterThan(SMALL.maxChunkCodePoints);
        const out = chunk(doc(longSentence + ' Curta.'), SMALL);
        expect(out[0]!.text).toBe(longSentence);
    });

    it('respects the budget when sentences fit', () => {
        for (const c of chunk(doc(PROSE), SMALL)) {
            // Only an oversized single sentence may exceed the budget, and
            // PROSE has none.
            expect(countCodePoints(c.text)).toBeLessThanOrEqual(SMALL.maxChunkCodePoints);
        }
    });

    it('with a generous budget the whole text is one chunk', () => {
        const out = chunk(doc(PROSE), DEFAULT_CHUNK_OPTIONS);
        expect(out).toHaveLength(1);
        expect(out[0]!.text).toBe(PROSE);
        expect(out[0]!.span).toEqual({ start: 0, end: countCodePoints(PROSE) });
    });
});

describe('chunk — coverage and overlap', () => {
    it('together the chunks cover every non-space character of the document, in order', () => {
        const d = doc(PROSE);
        const out = chunk(d, SMALL);
        expect(out[0]!.span.start).toBe(0);
        expect(out[out.length - 1]!.span.end).toBe(countCodePoints(d.text));
        // Every character that is not whitespace is inside at least one chunk.
        const covered = new Set<number>();
        for (const c of out) for (let i = c.span.start; i < c.span.end; i++) covered.add(i);
        Array.from(d.text).forEach((ch, i) => {
            if (!/\s/u.test(ch)) expect(covered.has(i), `code point ${i} (${ch}) uncovered`).toBe(true);
        });
        // And chunks advance: each starts strictly after the previous started.
        for (let i = 1; i < out.length; i++) {
            expect(out[i]!.span.start).toBeGreaterThan(out[i - 1]!.span.start);
        }
    });

    it('overlap repeats whole sentences from the previous tail, within budget', () => {
        const out = chunk(doc(PROSE), SMALL);
        expect(out.length).toBeGreaterThan(1);
        let sawOverlap = false;
        for (let i = 1; i < out.length; i++) {
            const overlap = out[i - 1]!.span.end - out[i]!.span.start;
            expect(overlap).toBeGreaterThanOrEqual(0);
            expect(overlap).toBeLessThanOrEqual(SMALL.maxOverlapCodePoints);
            if (overlap > 0) sawOverlap = true;
        }
        expect(sawOverlap).toBe(true);
    });

    it('zero overlap produces a partition whose only gaps are whitespace', () => {
        // Spans are trimmed to the sentence, so the space between two sentences
        // belongs to neither chunk. That gap is legitimate — and it must be
        // nothing BUT whitespace, or a character of the document fell through.
        const d = doc(PROSE);
        const out = chunk(d, { ...SMALL, maxOverlapCodePoints: 0 });
        for (let i = 1; i < out.length; i++) {
            const gap = sliceByCodePoints(d.text, out[i - 1]!.span.end, out[i]!.span.start);
            expect(gap.trim()).toBe('');
        }
    });

    it('accented text and emoji do not shift any span', () => {
        const d = doc('A ação é válida 💡. O réu não pagou 𝒳. Fim.');
        for (const c of chunk(d, { maxChunkCodePoints: 30, maxOverlapCodePoints: 0 })) {
            expect(c.text).toBe(sliceByCodePoints(d.text, c.span.start, c.span.end));
        }
    });
});

describe('chunk — abbreviations and numerals do not end a sentence', () => {
    // Two groups share this block. The numerals ("1.500", "R$ 2.000,00", "3.14",
    // "n.º") pin the SEGMENTER: measured on Node 24's Intl.Segmenter, it keeps
    // them whole on its own, and none matches the abbreviation pattern. The
    // titles ("art.", "Fig.", "Dr.") pin the MASK: they are list entries, so
    // the period the segmenter sees is already a mask character. Either way a
    // different or injected segmenter cannot silently start cutting a citation
    // at "art." or in the middle of "1.500".
    // Budget of ONE code point: every sentence is oversized, so every sentence
    // becomes its own chunk and `whole()` returns exactly what the segmenter
    // produced. A larger budget would let the chunker merge two short
    // sentences back together and hide a bad cut — which is what happened the
    // first time these were written.
    const whole = (text: string) =>
        chunk(doc(text), { maxChunkCodePoints: 1, maxOverlapCodePoints: 0 }).map((c) => c.text);

    it('a thousands separator is not a sentence end', () => {
        expect(whole('Custa 1.500 reais. Caro.')).toEqual(['Custa 1.500 reais.', 'Caro.']);
    });

    it('a currency amount with separators is not a sentence end', () => {
        expect(whole('Custam R$ 2.000,00 hoje. Amanhã sobe.')).toEqual(['Custam R$ 2.000,00 hoje.', 'Amanhã sobe.']);
    });

    it('a decimal point is not a sentence end', () => {
        expect(whole('Pi vale 3.14 aproximadamente. Fim.')).toEqual(['Pi vale 3.14 aproximadamente.', 'Fim.']);
    });

    it('"art." followed by a number is not a sentence end', () => {
        expect(whole('Ver art. 5º da lei. Depois vem.')).toEqual(['Ver art. 5º da lei.', 'Depois vem.']);
    });

    it('"Fig." followed by a number is not a sentence end', () => {
        expect(whole('Veja a Fig. 3 abaixo. Ela explica.')).toEqual(['Veja a Fig. 3 abaixo.', 'Ela explica.']);
    });

    it('"n.º" is not a sentence end', () => {
        expect(whole('O item n.º 4 falta. Confira.')).toEqual(['O item n.º 4 falta.', 'Confira.']);
    });

    // This was `it.fails` — a declared gap — until the abbreviation list
    // landed. The segmenter alone cuts after "Dr."; the mask hides the period
    // from it. The full behaviour is specified in abbreviations.test.ts.
    it('"Dr." followed by a capitalized name is not a sentence end', () => {
        expect(whole('O Dr. Silva chegou cedo. Foi rápido.')).toEqual(['O Dr. Silva chegou cedo.', 'Foi rápido.']);
    });
});

describe('chunk — options are validated at the door', () => {
    it('refuses a non-positive chunk size, naming the parameter', () => {
        expect(() => chunk(doc('x.'), { maxChunkCodePoints: 0, maxOverlapCodePoints: 0 }))
            .toThrow(/maxChunkCodePoints/);
    });

    it('refuses an overlap that is not smaller than the chunk, naming the parameter', () => {
        expect(() => chunk(doc('x.'), { maxChunkCodePoints: 10, maxOverlapCodePoints: 10 }))
            .toThrow(/maxOverlapCodePoints/);
    });

    it('accepts an injected segmenter', () => {
        // A segmenter that splits on "|" — proves the default is not hard-wired.
        const bar = {
            *segment(text: string) {
                let index = 0;
                for (const part of text.split('|')) {
                    yield { index, segment: part };
                    index += part.length + 1;
                }
            },
        };
        const out = chunk(doc('um|dois|três'), { maxChunkCodePoints: 5, maxOverlapCodePoints: 0, segmenter: bar });
        expect(out.map((c) => c.text)).toEqual(['um', 'dois', 'três']);
    });

    it('an empty document yields no chunks', () => {
        expect(chunk(doc(''), SMALL)).toEqual([]);
    });
});

/**
 * Regression: the budgets used to sum TRIMMED sentence lengths while the chunk
 * was emitted as one continuous interval, so the whitespace between sentences
 * was spent without being counted. Measured on the shipped corpus, 224 of 342
 * chunks of the Machado text and 40 of 581 overlaps crossed their ceiling by
 * exactly that whitespace.
 *
 * Every ceiling below is chosen to sit BETWEEN the trimmed sum and the
 * interval, which is the only region where the two versions disagree. All
 * three fail on the summing version.
 */
describe('chunk — the budget measures what is emitted, whitespace included', () => {
    /** 25 code points each, measured, joined by a blank line of 2. */
    const SENTENCE = 'Frase de vinte e quatro..';
    const gapped = (n: number) => Array.from({ length: n }, () => SENTENCE).join('\n\n');

    it('a chunk never exceeds the ceiling, even when the excess is only the gaps', () => {
        // Three sentences: 75 trimmed, 79 as an interval. A ceiling of 76
        // accepts the sum and refuses the interval.
        for (const c of chunk(doc(gapped(3)), { maxChunkCodePoints: 76, maxOverlapCodePoints: 0 })) {
            expect(countCodePoints(c.text)).toBeLessThanOrEqual(76);
        }
    });

    it('the sentence that does not fit is refused for the gaps, not for its own length', () => {
        const chunks = chunk(doc(gapped(3)), { maxChunkCodePoints: 76, maxOverlapCodePoints: 0 });
        expect(chunks).toHaveLength(2);
        // Two sentences and one gap. The summing version took all three and
        // emitted 79 in a single chunk.
        expect(countCodePoints(chunks[0]!.text)).toBe(52);
        expect(countCodePoints(chunks[1]!.text)).toBe(25);
    });

    it('an overlap never exceeds its ceiling, gaps included', () => {
        // A chunk of five sentences (133) and an overlap ceiling of 50:
        // stepping back two sentences is 50 trimmed and 52 as an interval.
        const chunks = chunk(doc(gapped(7)), { maxChunkCodePoints: 140, maxOverlapCodePoints: 50 });
        expect(chunks.length).toBeGreaterThan(1);
        for (let i = 1; i < chunks.length; i += 1) {
            const repeated = chunks[i - 1]!.span.end - chunks[i]!.span.start;
            expect(repeated).toBeLessThanOrEqual(50);
        }
    });
});

/**
 * Regression: the overlap could step back so far that the next chunk had no
 * room left for the sentence after it, and was emitted holding nothing but
 * text already present in its predecessor. Measured on the corpus before the
 * guard: three such chunks in 279, one of them `"Art. 12."` alone — eight code
 * points, the article number cut off from the article.
 *
 * The invariant is stated over spans rather than over the mechanism, so it
 * still holds if some future change produces redundancy by another route.
 */
describe('chunk — no chunk is pure repetition of the one before it', () => {
    /** Exactly `n` code points, ending in a period. Generated, never counted by hand. */
    const sentence = (n: number) => `Aa${'a'.repeat(n - 3)}.`;

    it('a short tail sentence is not emitted alone when the next one cannot fit with it', () => {
        // 40, 10 and 200 code points, blank line between. The chunk takes the
        // first two (52); stepping back over the 10 would leave a chunk that
        // cannot reach the 200, so it does not step back.
        const text = [sentence(40), sentence(10), sentence(200)].join('\n\n');
        const chunks = chunk(doc(text), { maxChunkCodePoints: 100, maxOverlapCodePoints: 50 });

        expect(chunks).toHaveLength(2);
        expect(countCodePoints(chunks[0]!.text)).toBe(52);
        // The oversized sentence, alone and whole, as the contract promises.
        expect(countCodePoints(chunks[1]!.text)).toBe(200);
    });

    it('no chunk is contained in its predecessor, over several shapes', () => {
        const shapes = [
            [40, 10, 200],
            [30, 30, 30, 500],
            [200, 12, 300, 15, 400],
            [10, 10, 10, 10, 10, 900],
        ];
        for (const shape of shapes) {
            const text = shape.map(sentence).join('\n\n');
            const chunks = chunk(doc(text), { maxChunkCodePoints: 100, maxOverlapCodePoints: 50 });
            for (let i = 1; i < chunks.length; i += 1) {
                const previous = chunks[i - 1]!;
                const current = chunks[i]!;
                const contained =
                    current.span.start >= previous.span.start && current.span.end <= previous.span.end;
                expect({ shape, i, contained }).toEqual({ shape, i, contained: false });
            }
        }
    });

    it('every chunk still adds at least one code point the previous one did not have', () => {
        const text = [40, 10, 200, 8, 150].map(sentence).join('\n\n');
        const chunks = chunk(doc(text), { maxChunkCodePoints: 100, maxOverlapCodePoints: 50 });
        for (let i = 1; i < chunks.length; i += 1) {
            expect(chunks[i]!.span.end).toBeGreaterThan(chunks[i - 1]!.span.end);
        }
    });
});
