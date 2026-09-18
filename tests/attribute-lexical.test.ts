import { describe, it, expect } from 'vitest';
import {
    clausesOf,
    candidateFrequencies,
    separationWeight,
    sustainWeight,
    coverageOf,
    lexicalRung,
    distinctTerms,
    MIN_LEXICAL_SUPPORT,
    LEXICAL_MARGIN,
    type AttributeOptions,
} from '../src/attribute.js';
import { createTokenizer } from '../src/tokenizer.js';
import { luceneIdf } from '../src/bm25.js';

const tokenizer = createTokenizer();
const opts: AttributeOptions = { tokenizer };

/** Candidate passages reduced to their term sets, which is all the rung reads. */
function passage(text: string) {
    return distinctTerms(text, tokenizer);
}

describe('clausesOf — the unit of attribution is the clause', () => {
    it('splits on the same boundary the chunker cuts on', () => {
        const text = 'O réu confessou. A arma foi apreendida.';
        expect(clausesOf(text, opts).map((c) => c.span)).toEqual([
            { start: 0, end: 16 },
            { start: 17, end: 39 },
        ]);
    });

    it('does not split inside an abbreviation, so the clause stays whole', () => {
        const text = 'Segundo o art. 5º da lei, o prazo corre.';
        expect(clausesOf(text, opts)).toHaveLength(1);
    });

    it('measures the clause in code points and reads it back correctly past an emoji', () => {
        // 💡 is one code point and two UTF-16 units. A clause sliced with the
        // code point offset against a UTF-16 index would come back short.
        const text = '💡 A ideia veio antes. A prova veio depois.';
        const [first, second] = clausesOf(text, opts);
        expect(first!.span).toEqual({ start: 0, end: 21 });
        expect(second!.terms.has('prova')).toBe(true);
        expect(second!.terms.has('ideia')).toBe(false);
    });
});

describe('separationWeight — what tells the candidates apart', () => {
    it('a term no candidate carries separates nobody, so it weighs nothing', () => {
        // luceneIdf would hand df=0 the LARGEST weight in the table — it is
        // only documented as strictly positive and decreasing for df in 1..N.
        expect(separationWeight(0, 10)).toBe(0);
        expect(luceneIdf(10, 0)).toBeGreaterThan(luceneIdf(10, 1));
    });

    it('a term every candidate carries still weighs something, but the least', () => {
        expect(separationWeight(10, 10)).toBeGreaterThan(0);
        expect(separationWeight(10, 10)).toBeLessThan(separationWeight(1, 10));
    });
});

describe('sustainWeight — what counts against a passage that lacks the word', () => {
    it('an unobserved term is capped at the weight of the rarest observed one', () => {
        // df = 0 means UNOBSERVED among these candidates, not "rarer than
        // everything else". Without the cap it would carry the largest weight
        // in the sum on the strength of no evidence at all.
        expect(sustainWeight(0, 10)).toBe(sustainWeight(1, 10));
        expect(sustainWeight(0, 10)).toBeLessThan(luceneIdf(10, 0));
    });

    it('capped, it is still the largest weight available, so absent terms dominate', () => {
        // This is the intended direction, and it is why coverage is an UPPER
        // bound rather than an estimate.
        for (const df of [1, 2, 5, 10]) {
            expect(sustainWeight(0, 10)).toBeGreaterThanOrEqual(sustainWeight(df, 10));
        }
    });
});

describe('coverageOf — the number published as confidence', () => {
    const candidates = [passage('o réu confessou o crime'), passage('a arma foi apreendida')];
    const df = candidateFrequencies(candidates);

    it('is the share of the clause weight the passage carries', () => {
        const clause = distinctTerms('o réu confessou', tokenizer);
        expect(coverageOf(clause, candidates[0]!, df, 2)).toBe(1);
        expect(coverageOf(clause, candidates[1]!, df, 2)).toBe(0);
    });

    it('a clause with no terms has no fraction, and says so instead of NaN', () => {
        // A lone dash, a line that is only a formula, an emoji. Answering NaN
        // would make every comparison false and send the clause to the network
        // to ask which passage supports a clause with no words in it.
        const empty = distinctTerms('—', tokenizer);
        expect(empty.size).toBe(0);
        expect(coverageOf(empty, candidates[0]!, df, 2)).toBeNull();
    });

    it('drops as terms the passage lacks are added, at most one per matched term', () => {
        const one = distinctTerms('réu confessou', tokenizer);
        const withAbsent = distinctTerms('réu confessou helicóptero', tokenizer);
        const a = coverageOf(one, candidates[0]!, df, 2)!;
        const b = coverageOf(withAbsent, candidates[0]!, df, 2)!;
        expect(b).toBeLessThan(a);
    });
});

describe('lexicalRung — clear, tied, or nothing to attribute', () => {
    it('names the passage that carries the clause when one clearly does', () => {
        const candidates = [
            passage('o réu confessou o crime durante a audiência'),
            passage('a perícia analisou vestígios encontrados no veículo'),
        ];
        const df = candidateFrequencies(candidates);
        const [clause] = clausesOf('O réu confessou o crime.', opts);
        const out = lexicalRung(clause!, candidates, df);
        expect(out.kind).toBe('clear');
        if (out.kind === 'clear') expect(out.index).toBe(0);
    });

    it('calls it tied when the winner is not ahead by the margin', () => {
        // Both passages carry the same discriminating terms, so neither is
        // ahead at all — the words cannot separate them and the clause has to
        // go to a rung that does not read words.
        const candidates = [passage('o réu confessou'), passage('o réu confessou')];
        const df = candidateFrequencies(candidates);
        const [clause] = clausesOf('O réu confessou.', opts);
        expect(lexicalRung(clause!, candidates, df).kind).toBe('tied');
    });

    it('calls it tied when the best passage is below the support floor', () => {
        const candidates = [passage('o réu confessou'), passage('a perícia analisou o veículo')];
        const df = candidateFrequencies(candidates);
        // One shared term against several the passage does not have.
        const [clause] = clausesOf(
            'O réu contratou peritos independentes, agrimensores e tradutores juramentados.',
            opts,
        );
        const out = lexicalRung(clause!, candidates, df);
        expect(out.kind).toBe('tied');
    });

    it('a clause with no terms is unattributable and never reaches a rung that pays', () => {
        const candidates = [passage('o réu confessou')];
        const df = candidateFrequencies(candidates);
        const [clause] = clausesOf('—', opts);
        expect(clause!.terms.size).toBe(0);
        expect(lexicalRung(clause!, candidates, df).kind).toBe('unattributable');
    });

    it('a clause sharing nothing with any candidate is unattributable', () => {
        const candidates = [passage('o réu confessou')];
        const df = candidateFrequencies(candidates);
        const [clause] = clausesOf('Helicópteros sobrevoaram a ilha.', opts);
        expect(lexicalRung(clause!, candidates, df).kind).toBe('unattributable');
    });
});

describe('the two thresholds are exported to be read, not guessed', () => {
    it('both are documented as arbitrary until the ruler measures them', () => {
        expect(MIN_LEXICAL_SUPPORT).toBeGreaterThan(0);
        expect(MIN_LEXICAL_SUPPORT).toBeLessThan(1);
        expect(LEXICAL_MARGIN).toBeGreaterThan(1);
    });
});
