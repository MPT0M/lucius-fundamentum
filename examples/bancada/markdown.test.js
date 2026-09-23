/**
 * What the bench takes out of a grounded answer's markdown, and the promise
 * that it can all be put back.
 *
 * The property that carries the rest is the round trip: `restoreRemovals` of a
 * text's removals into its clean text returns the raw text exactly. The copy
 * button depends on it — the format that goes in is the format that comes out —
 * so every fixture here is checked for it, and not only the ones about
 * restoring.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { renderableFrom, restoreRemovals } from './markdown.js';

const TICK = '`';
const FENCE = TICK.repeat(3);

/** @param {{ text: string }} r @param {{ start: number, end: number }} s */
const cut = (r, s) => Array.from(r.text).slice(s.start, s.end).join('');

/** @param {string} raw */
function parsed(raw) {
    const r = renderableFrom(raw);
    expect(restoreRemovals(r.text, r.removals)).toBe(raw);
    return r;
}

describe('renderableFrom — the syntax it takes out', () => {
    it('a heading keeps its words and says its level', () => {
        const r = parsed('## Conclusão');
        expect(r.text).toBe('Conclusão');
        expect(r.blocks).toEqual([{ start: 0, end: 9, line: 0, kind: 'heading', level: 2 }]);
    });

    it('the line of a block is counted over the whole text, blank lines included', () => {
        // The screen finds a block by this number and walks paragraphs, which
        // skip blank lines. A count kept per paragraph would put the second
        // heading here one line early; the number has to be global.
        const r = parsed('# Um\ntexto\n\n## Dois\nmais');
        expect(r.blocks.map((b) => `${b.line}:${cut(r, b)}`)).toEqual(['0:Um', '3:Dois']);
        const lines = r.text.split('\n');
        for (const b of r.blocks) expect(lines[b.line]).toBe(cut(r, b));
    });

    it('list items and quotes are blocks of their own line', () => {
        const r = parsed('- um\n* dois\n+ tres\n> citado');
        expect(r.text).toBe('um\ndois\ntres\ncitado');
        expect(r.blocks.map((b) => `${b.kind}=${cut(r, b)}`)).toEqual([
            'item=um', 'item=dois', 'item=tres', 'quote=citado',
        ]);
    });

    it('strong and emphasis become marks over the words they held', () => {
        const r = parsed('A **hipótese** vale e *isto* também, e __aquilo__.');
        expect(r.text).toBe('A hipótese vale e isto também, e aquilo.');
        expect(r.marks.map((m) => `${m.kind}=${cut(r, m)}`)).toEqual([
            'strong=hipótese', 'em=isto', 'strong=aquilo',
        ]);
    });

    it('three asterisks are strong and emphasis over the same words, and one removal each side', () => {
        const r = parsed('***negrito e itálico*** aqui');
        expect(r.marks.map((m) => `${m.kind}=${cut(r, m)}`)).toEqual([
            'strong=negrito e itálico', 'em=negrito e itálico',
        ]);
        expect(r.removals.map((x) => x.text)).toEqual(['***', '***']);
    });

    it('a backslash makes the next character literal and is itself removed', () => {
        const r = parsed('literal \\*nao* e *sim*');
        expect(r.text).toBe('literal *nao* e sim');
        expect(r.marks.map((m) => cut(r, m))).toEqual(['sim']);
    });
});

describe('renderableFrom — what it leaves as written', () => {
    it('code and formulas keep their delimiters, and nothing inside them is read', () => {
        // The mask protects code and formulas BY their delimiters; removing
        // them would expose `obj.method()` to the segmenter.
        const raw = `veja ${TICK}a**b${TICK} e $a*b$ fim`;
        const r = parsed(raw);
        expect(r.text).toBe(raw);
        expect(r.marks).toEqual([]);
    });

    it('a heading-looking line inside a fenced block is code, not a heading', () => {
        const raw = `${FENCE}\n# install\n${FENCE}`;
        expect(parsed(raw).blocks).toEqual([]);
    });

    it('an unpaired fence protects nothing, because the mask protects nothing there', () => {
        // Where code starts is asked of `maskProtectedRegions`, not re-derived,
        // and its fence pattern needs a pair. So the two agree by construction:
        // with no closing fence the next line is read as markdown.
        const r = parsed(`${FENCE}\n# titulo`);
        expect(r.blocks.map((b) => b.kind)).toEqual(['heading']);
    });

    it('underscores inside a word are not emphasis', () => {
        const raw = 'snake_case e a__b__c';
        const r = parsed(raw);
        expect(r.text).toBe(raw);
        expect(r.marks).toEqual([]);
    });

    it('a marker needs the space after it, so dialogue and lone asterisks stay text', () => {
        // Measured on the bench corpus: 473 lines of Machado open with `--`
        // and three statutes carry a lone `*`; none has the space.
        for (const raw of ['--Já?', '*', '5 * 3', '#tag']) {
            const r = parsed(raw);
            expect(r.text, raw).toBe(raw);
            expect(r.blocks, raw).toEqual([]);
        }
    });

    it('emphasis does not pair across a line', () => {
        // So no mark crosses a newline, and none crosses into a block: the
        // screen draws a block as an element of its own and has no rule for a
        // mark split between two. The real shape is a model that opens `**`
        // and closes it many lines later.
        const r = parsed('**a\n## b**');
        expect(r.text).toBe('**a\nb**');
        expect(r.marks).toEqual([]);
        expect(r.blocks.map((b) => `${b.line}:${b.kind}`)).toEqual(['1:heading']);
    });

    it('delimiter runs pair only with a run of the same length', () => {
        // The nested reading CommonMark would give — emphasis with a strong
        // inside — is left out on purpose: equal-length pairing needs no
        // tie-break, and one removal per side keeps `**` and `*` from ever
        // being two coincident removals to order.
        const raw = '***a** b*';
        const r = parsed(raw);
        expect(r.text).toBe(raw);
        expect(r.marks).toEqual([]);
    });

    it('a line takes one block prefix, so a list item inside a quote stays text', () => {
        const r = parsed('> - x');
        expect(r.text).toBe('- x');
        expect(r.blocks.map((b) => `${b.kind}=${cut(r, b)}`)).toEqual(['quote=- x']);
    });

    it('an ordered-list numeral is content and stays', () => {
        const r = parsed('1. **Lucro e Filantropia**');
        expect(r.text).toBe('1. Lucro e Filantropia');
        expect(r.blocks).toEqual([]);
    });
});

describe('renderableFrom — the removals the copy puts back', () => {
    it('an opener keeps a marker outside it, a closer lets one follow it', () => {
        const r = parsed('**forte**');
        expect(r.removals.map((x) => `${x.text}@${x.start}:${x.attach}`)).toEqual([
            '**@0:right', '**@5:left',
        ]);
    });

    it('two removals at one point come back in the order they had', () => {
        // `## **Título**` takes out `## ` and `**` at the same clean position.
        // Restored in the wrong order it would read `**## Título**`.
        const r = parsed('## **Título**');
        expect(r.removals.filter((x) => x.start === 0).map((x) => x.text)).toEqual(['## ', '**']);
    });

    it('a real answer survives the round trip, with enumerators and emphasis side by side', () => {
        // The labeled fixture the design names as the tightest: `***Memórias
        // Póstumas…***`, `**"Emplasto Brás Cubas"**` with quotes against the
        // delimiters, and `1. **Lucro e Filantropia` with a numeral and an
        // opener in adjacent code points.
        for (const name of ['q02-plain.json']) {
            const fixture = JSON.parse(readFileSync(new URL(`../../bench/fixtures/labeled/${name}`, import.meta.url), 'utf8'));
            // The control a disk-driven fixture needs: a relabelled file, a
            // renamed field or an empty `parts` would make the loop run over
            // nothing and pass as loudly as a real round trip.
            expect(fixture.parts.length, name).toBeGreaterThan(0);
            let stripped = 0;
            for (const part of fixture.parts) if (parsed(part.text).text !== part.text) stripped++;
            // And the round trip is vacuous over text with no syntax in it.
            expect(stripped, name).toBeGreaterThan(0);
        }
    });
});

describe('restoreRemovals — a pass with a cursor', () => {
    it('with nothing to restore, the text comes back unchanged', () => {
        expect(restoreRemovals('texto', [])).toBe('texto');
    });

    it('keeps the listed order at a shared position, which splicing would reverse', () => {
        expect(restoreRemovals('Título', [
            { start: 0, text: '## ' },
            { start: 0, text: '**' },
            { start: 6, text: '**' },
        ])).toBe('## **Título**');
    });
});
