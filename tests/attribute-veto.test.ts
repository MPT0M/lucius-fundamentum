import { describe, it, expect } from 'vitest';
import {
    clausesOf,
    candidateFrequencies,
    distinctTerms,
    numeralsOf,
    matchedSentenceOf,
    vetoes,
    NEGATION_MARKERS,
    type AttributeOptions,
} from '../src/attribute.js';
import { createTokenizer } from '../src/tokenizer.js';
import type { Span } from '../src/types.js';

const tokenizer = createTokenizer();
const opts: AttributeOptions = { tokenizer };

/** A passage as the veto sees it: its text, and where it sits in the document. */
function chunkAt(text: string, start: number): { text: string; span: Span } {
    return { text, span: { start, end: start + Array.from(text).length } };
}

function terms(text: string) {
    return distinctTerms(text, tokenizer);
}

describe('NEGATION_MARKERS — folded the way the tokenizer folds', () => {
    it('every marker is a term the tokenizer actually produces', () => {
        // Written from the spelling, `não` and `ninguém` would never match and
        // the rule would veto nothing, in silence.
        const produced = terms('não nunca jamais nenhum nenhuma ninguém nada nem sem');
        for (const marker of NEGATION_MARKERS) expect(produced.has(marker)).toBe(true);
    });
});

describe('numeralsOf — the tokenizer keeps a figure whole', () => {
    it('a legal reference, an ISO date and a clock time are one term each', () => {
        const found = numeralsOf(terms('A Lei 8.078/90 entrou em vigor em 2026-09-09 às 12:30.'));
        expect([...found].sort()).toEqual(['12:30', '2026-09-09', '8.078/90']);
    });

    it('a clause with no figures has no numerals to check', () => {
        expect(numeralsOf(terms('O réu confessou.')).size).toBe(0);
    });
});

describe('matchedSentenceOf — located in the document, computed per candidate', () => {
    const chunk = chunkAt('A perícia foi inconclusiva. O réu confessou o crime. O prazo corre.', 500);

    it('finds the sentence that carries the clause and reports document offsets', () => {
        const [clause] = clausesOf('O réu confessou.', opts);
        const candidates = [terms(chunk.text)];
        const df = candidateFrequencies(candidates);
        const matched = matchedSentenceOf(clause!, chunk, df, 1, opts)!;
        // 500 is the chunk's own start: the offsets are the document's.
        expect(matched.span.start).toBeGreaterThanOrEqual(500);
        const local = {
            start: matched.span.start - 500,
            end: matched.span.end - 500,
        };
        expect(chunk.text.slice(local.start, local.end)).toBe('O réu confessou o crime.');
    });

    it('a clause sharing no term at all matches no sentence', () => {
        const [clause] = clausesOf('Helicópteros sobrevoaram ilhas distantes.', opts);
        const candidates = [terms(chunk.text)];
        const df = candidateFrequencies(candidates);
        expect(matchedSentenceOf(clause!, chunk, df, 1, opts)).toBeNull();
    });

    it('a function word is a shared term, and it decides only because nothing else does', () => {
        // The tokenizer keeps `a`, `o`, `de` — there is no stopword list, by
        // design: a term present everywhere gets a small idf and stops mattering
        // on its own, which is how BM25 already treats it in the index. The
        // consequence here is that a clause sharing ONLY function words still
        // matches a sentence, on a weight close to zero. Naming it so nobody
        // reads a match as evidence of anything.
        const [clause] = clausesOf('A comissão deliberou.', opts);
        const candidates = [terms(chunk.text)];
        const df = candidateFrequencies(candidates);
        const matched = matchedSentenceOf(clause!, chunk, df, 1, opts);
        expect(matched).not.toBeNull();
        expect(clause!.terms.has('a')).toBe(true);
    });
});

describe('vetoes — it only ever rejects', () => {
    const passage = chunkAt('O prazo é de 15 dias corridos. A contagem exclui o dia inicial.', 0);
    const passageTerms = terms(passage.text);
    const candidates = [passageTerms];
    const df = candidateFrequencies(candidates);

    function judge(answer: string) {
        const [clause] = clausesOf(answer, opts);
        const matched = matchedSentenceOf(clause!, passage, df, 1, opts);
        return vetoes(clause!, passageTerms, matched);
    }

    it('a figure the answer states and the passage lacks rejects the candidate', () => {
        // The number the model computed rather than read is exactly the case
        // this rule exists for.
        expect(judge('O prazo é de 30 dias.')).toBe('numeral');
    });

    it('a figure both carry does not reject', () => {
        expect(judge('O prazo é de 15 dias.')).toBeNull();
    });

    it('a numeral is checked against the WHOLE passage, not the matched sentence', () => {
        // `15` lives in the first sentence; the clause matches the second. A
        // rule scoped to the sentence would reject a passage that supports it.
        const about = 'A contagem exclui o dia inicial dos 15 dias.';
        expect(judge(about)).toBeNull();
    });

    it('a negated clause against an affirmative sentence rejects', () => {
        expect(judge('O prazo não é de 15 dias.')).toBe('negation');
    });

    it('negation is checked against the SENTENCE, so a marker elsewhere does not fire', () => {
        // The passage carries a negation in its second sentence and none in the
        // first. A clause matching the first is affirmative and supported;
        // checking the whole passage would produce a FALSE veto, which is the
        // one direction a veto must not err in.
        const mixed = chunkAt('O recurso é cabível na hipótese. O agravo não é cabível.', 0);
        const mixedTerms = terms(mixed.text);
        const mdf = candidateFrequencies([mixedTerms]);
        const [clause] = clausesOf('O recurso é cabível.', opts);
        const matched = matchedSentenceOf(clause!, mixed, mdf, 1, opts);
        expect(vetoes(clause!, mixedTerms, matched)).toBeNull();
    });

    it('reinforcing negation puts markers on both sides and does not fire', () => {
        const both = chunkAt('O perito não encontrou nenhum vestígio no local.', 0);
        const bothTerms = terms(both.text);
        const bdf = candidateFrequencies([bothTerms]);
        const [clause] = clausesOf('O perito não viu ninguém.', opts);
        const matched = matchedSentenceOf(clause!, both, bdf, 1, opts);
        expect(vetoes(clause!, bothTerms, matched)).toBeNull();
    });

    it('negation without a lexical marker does not fire — the declared limit', () => {
        // "deixou de comparecer" is a negation the rule cannot see. It passes,
        // which is the safe direction: a veto that only rejects errs by letting
        // through, never by dropping a correct citation.
        const present = chunkAt('A testemunha compareceu à audiência.', 0);
        const presentTerms = terms(present.text);
        const pdf = candidateFrequencies([presentTerms]);
        const [clause] = clausesOf('A testemunha deixou de comparecer à audiência.', opts);
        const matched = matchedSentenceOf(clause!, present, pdf, 1, opts);
        expect(vetoes(clause!, presentTerms, matched)).toBeNull();
    });
});
