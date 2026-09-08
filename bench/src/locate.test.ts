import { describe, it, expect } from 'vitest';
import { locateSnippet } from './locate.js';
import type { MaskedCorpus } from './corpus.js';
import { maskProtectedRegions } from '../../src/mask.js';
import { sliceByCodePoints, countCodePoints } from '../../src/unicode.js';

/** A view built the way run.ts will build the round: regions come from the package. */
function view(docs: Record<string, string>): MaskedCorpus {
    return new Map(Object.entries(docs).map(([id, text]) => [id, { text, regions: maskProtectedRegions(text).spans }]));
}

const LAW = 'Art. 5º Todos são iguais perante a lei. Art. 6º São direitos sociais a educação.';
const DECREE = 'Art. 1º Fica aprovado o regulamento. São direitos sociais a educação e a saúde.';

describe('locateSnippet — one occurrence is a position', () => {
    it('finds a snippet once and reports the document and the code point span', () => {
        const v = view({ law: LAW, decree: DECREE });
        const r = locateSnippet(v, 'Todos são iguais perante a lei.');
        expect(r).toEqual({ kind: 'exact', documentId: 'law', span: { start: 8, end: 39 } });
    });

    it('positions are code points, not UTF-16 units — an accent before the snippet does not shift it', () => {
        // "𝒳" is two UTF-16 units and one code point; "ã" is one of each.
        const text = 'x' + String.fromCodePoint(0x1d4b3) + ' ãção alvo aqui';
        const r = locateSnippet(view({ d: text }), 'alvo');
        expect(r.kind).toBe('exact');
        if (r.kind !== 'exact') return;
        expect(sliceByCodePoints(text, r.span.start, r.span.end)).toBe('alvo');
        expect(r.span).toEqual({ start: 8, end: 12 });
    });

    it('a snippet containing an astral character spans its code points, not its UTF-16 units', () => {
        // "x𝒳y" is 3 code points and 4 UTF-16 units; an end computed in units
        // would overshoot by one and the slice would swallow the next character.
        const snippet = 'x' + String.fromCodePoint(0x1d4b3) + 'y';
        const text = 'ab ' + snippet + 'Z';
        const r = locateSnippet(view({ d: text }), snippet);
        expect(r).toEqual({ kind: 'exact', documentId: 'd', span: { start: 3, end: 6 } });
        if (r.kind === 'exact') expect(sliceByCodePoints(text, r.span.start, r.span.end)).toBe(snippet);
    });

    it('a snippet equal to the whole document is one occurrence covering it all', () => {
        const r = locateSnippet(view({ d: LAW }), LAW);
        expect(r).toEqual({ kind: 'exact', documentId: 'd', span: { start: 0, end: countCodePoints(LAW) } });
    });
});

describe('locateSnippet — none is a named bucket, never a guess', () => {
    it('a snippet the emitter altered is not_found and travels with the result', () => {
        const r = locateSnippet(view({ law: LAW }), 'Todos  são iguais'); // double space: whitespace collapsed by the emitter
        expect(r).toEqual({ kind: 'not_found', snippet: 'Todos  são iguais' });
    });

    it('an empty snippet is not_found without a scan', () => {
        expect(locateSnippet(view({ law: LAW }), '')).toEqual({ kind: 'not_found', snippet: '' });
    });

    it('a snippet present in the round but absent from the view is not_found — the view is the scope', () => {
        // parse.ts hands the locator only the fixture's documents. What the
        // rest of the corpus contains is not this fixture's business.
        const onlyDecree = view({ decree: DECREE });
        expect(locateSnippet(onlyDecree, 'Todos são iguais').kind).toBe('not_found');
    });
});

describe('locateSnippet — two or more is ambiguous, with every occurrence and its document', () => {
    it('repeated text inside one document lists both positions, in order', () => {
        const r = locateSnippet(view({ law: LAW }), 'Art.');
        expect(r.kind).toBe('ambiguous');
        if (r.kind !== 'ambiguous') return;
        expect(r.occurrences).toEqual([
            { documentId: 'law', span: { start: 0, end: 4 } },
            { documentId: 'law', span: { start: 40, end: 44 } },
        ]);
    });

    it('the same text in two documents lists both, ordered by document id then position', () => {
        // Map insertion order is law-first on purpose — the opposite of id
        // order — so a locator that walked the map as built would report
        // ['law', 'decree'] and fail here. The result must not depend on how
        // the map was assembled.
        const v = view({ law: LAW, decree: DECREE });
        const r = locateSnippet(v, 'São direitos sociais a educação');
        expect(r.kind).toBe('ambiguous');
        if (r.kind !== 'ambiguous') return;
        expect(r.occurrences.map((o) => o.documentId)).toEqual(['decree', 'law']);
        for (const o of r.occurrences) {
            expect(sliceByCodePoints(v.get(o.documentId)!.text, o.span.start, o.span.end)).toBe('São direitos sociais a educação');
        }
    });

    it('overlapping occurrences count separately — each is a place the citation could have meant', () => {
        const r = locateSnippet(view({ d: 'aaa' }), 'aa');
        expect(r.kind).toBe('ambiguous');
        if (r.kind !== 'ambiguous') return;
        expect(r.occurrences.map((o) => o.span.start)).toEqual([0, 1]);
    });

    it('a single occurrence never comes back ambiguous — the boundary is two', () => {
        // TypeScript cannot express "at least two", so this is the guard: a
        // change that let a lone occurrence leak into `ambiguous` fails HERE,
        // under this name, not in a test about `exact`.
        const v = view({ law: LAW, decree: DECREE });
        for (const snippet of ['Todos são iguais', 'Fica aprovado', 'e a saúde']) {
            const r = locateSnippet(v, snippet);
            expect(r.kind, snippet).toBe('exact');
        }
        for (const snippet of ['Art.', 'São direitos sociais a educação', 'a']) {
            const r = locateSnippet(v, snippet);
            expect(r.kind, snippet).toBe('ambiguous');
            if (r.kind === 'ambiguous') expect(r.occurrences.length).toBeGreaterThanOrEqual(2);
        }
        // The boundary: a text repeated exactly twice is the smallest ambiguity.
        const twice = locateSnippet(view({ d: 'x y x' }), 'x');
        expect(twice.kind).toBe('ambiguous');
        if (twice.kind === 'ambiguous') expect(twice.occurrences).toHaveLength(2);
    });
});
