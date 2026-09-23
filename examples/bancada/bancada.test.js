/**
 * The example's decisions, pinned.
 *
 * It lives here rather than in `tests/` for the reason `bench/src` does: a
 * `.ts` test cannot import this `.js` module without `allowJs`, and turning
 * that on for the main type-check config drags in files this example has no
 * business touching. So the test sits beside its subject, type-checked by
 * `tsconfig.example.json` and pulled into the suite by one glob — the glob
 * `example-scaffold.test.ts` pins, for the same silent-drop reason
 * `scaffold.test.ts` pins the bench's.
 *
 * What is worth a test here is not that the page renders. It is the rules the
 * bench must get right for the library's own promises to survive the trip to a
 * screen — a property, not a count, because the list was written when there
 * were two and five more arrived without it being revisited. Three of them are
 * worth naming: never collapsing the two reasons the dense arm is off, never
 * cutting text anywhere but a code point boundary, and never letting a question
 * reach the provider while the screen says your documents stay here. The last
 * one is the only one a reader sees stated on the screen, which is what makes
 * it the one that costs most to get wrong.
 */

import { describe, it, expect } from 'vitest';
import {
    describeArm,
    snippetOf,
    resultForScreen,
    documentFromPastedText,
    buildLexicalIndex,
    attributeWithoutKey,
    markedAnswer,
    copiedAnswer,
    describeRungs,
    looksReadable,
    documentFromFile,
    isPdf,
    pageToDocument,
    hasUsableText,
    MIN_USABLE_LETTERS,
    classifyLoadFailure,
    corpusFrom,
    rungSentence,
    highlightParts,
    viewerFor,
    remoteProvider,
    buildDenseIndex,
    attributeWithKey,
    providerMayBeAsked,
    pageIdOf,
    fileOfId,
    pageOfId,
    unsupportedRanges,
    codePointsOf,
    paragraphBoundsOf,
    markersIn,
    piecesOf,
} from './bancada.js';
import { loadIndex, packVectors, deterministicProvider, formatAttribution } from '../../dist/index.js';
import { renderableFrom, restoreRemovals } from './markdown.js';

/** @typedef {import('../../dist/index.js').SearchResult} SearchResult */

/**
 * @param {string} text
 * @param {number} [pageNumber]
 * @returns {SearchResult}
 */
function hit(text, pageNumber) {
    const span = { start: 0, end: text.length };
    return pageNumber === undefined
        ? { chunk: { id: 'c#0', documentId: 'd', text, span }, score: 1, rank: 1 }
        : { chunk: { id: 'c#0', documentId: 'd', text, span, pageNumber }, score: 1, rank: 1 };
}

describe('the bench says which negative it is looking at', () => {
    it('offers embedding for `absent` and for nothing else', () => {
        // `DenseArm`'s docblock states the cost of merging them: a caller that
        // does "offers 're-read 40 documents' to someone who only had to
        // supply a key". `needs-provider` means the vectors are already in
        // the artifact and one argument turns the arm on.
        expect(describeArm('absent').offersEmbedding).toBe(true);
        expect(describeArm('needs-provider').offersEmbedding).toBe(false);
        expect(describeArm('ready').offersEmbedding).toBe(false);
    });

    it('gives the three states three different sentences', () => {
        const said = ['ready', 'needs-provider', 'absent'].map((a) =>
            describeArm(/** @type {'ready' | 'needs-provider' | 'absent'} */ (a)).headline,
        );
        expect(new Set(said).size).toBe(3);
    });

    it('never tells someone who already has vectors to pay for them again', () => {
        const detail = describeArm('needs-provider').detail;
        expect(detail).toContain('nothing is embedded a second time');
        expect(detail).not.toContain('costs money');
        // The contrast is the point: `absent` is the one state where that
        // sentence is honest.
        expect(describeArm('absent').detail).toContain('costs money');
    });
});

describe('a page id is read the same way it is written', () => {
    it('gives back the file and the page it was built from', () => {
        const id = pageIdOf('lei.pdf', 7);
        expect(fileOfId(id)).toBe('lei.pdf');
        expect(pageOfId(id)).toBe(7);
    });

    it('leaves an id with no page alone', () => {
        // A dropped `.txt` is one document with no page, and its id is the
        // file name itself. Trimming something off it would key the register
        // under a name no tile carries.
        expect(fileOfId('notas.txt')).toBe('notas.txt');
        expect(pageOfId('notas.txt')).toBeUndefined();
    });

    it('cuts at the last marker, not the first', () => {
        // The separator is legal in a file name, and the reader that stops at
        // the first one loses the rest of the name — silently, by keying the
        // register under a file nothing else mentions.
        const id = pageIdOf('draft#p1 final.pdf', 3);
        expect(fileOfId(id)).toBe('draft#p1 final.pdf');
        expect(pageOfId(id)).toBe(3);
    });
});

describe('the answer is measured in the unit the library answers in', () => {
    // `𝒳` is one code point and two UTF-16 units. The library returns every
    // offset in code points and says so in three places in its own source;
    // JavaScript indexes strings in units. They agree on ASCII and part ways
    // at the first astral character — which is why the bug is invisible until
    // somebody grounds an answer with an emoji in it, and then the dashed
    // underline sits one character early for every astral character before it.
    const ASTRAL = '𝒳';

    it('counts a surrogate pair as one position', () => {
        const points = codePointsOf(`${ASTRAL}ab`);
        expect(points).toHaveLength(3);
        // The naive version, for contrast: this is the count the drawing used
        // to take, and it is what makes every later offset wrong.
        expect(`${ASTRAL}ab`.length).toBe(4);
    });

    it('finds a marker at its code point position, not its unit position', () => {
        const text = `${ASTRAL} o prazo [1].`;
        const found = markersIn(codePointsOf(text), 0, codePointsOf(text).length);

        expect(found).toHaveLength(1);
        expect(found[0]).toEqual({ start: 10, end: 13, marker: 1 });
        // Where a regex over the string puts it — one position later, because
        // the astral character counts twice there. One character of drift per
        // astral character before the marker.
        expect(text.indexOf('[1]')).toBe(11);
    });

    it('slices the marked stretch at the same words after an astral character', () => {
        const points = codePointsOf(`${ASTRAL}${ASTRAL} O prazo e de quinze dias.`);
        const gaps = unsupportedRanges(points.length, [{ start: 0, end: 11 }]);

        expect(gaps).toEqual([{ start: 11, end: points.length }]);
        expect(points.slice(11).join('')).toBe('e de quinze dias.');
        // What the same offsets produce read as UTF-16 units: two characters
        // off, landing mid-word. The assertion above is what the fix buys.
        expect(`${ASTRAL}${ASTRAL} O prazo e de quinze dias.`.slice(11)).not.toBe('e de quinze dias.');
    });

    it('ends a paragraph on a blank line and not on a wrapped one', () => {
        const points = codePointsOf('um\ndois\n\ntres');
        expect(paragraphBoundsOf(points)).toEqual([
            [0, 7],
            [9, 13],
        ]);
        expect(points.slice(0, 7).join('')).toBe('um\ndois');
        expect(points.slice(9, 13).join('')).toBe('tres');
    });

    it('gives one bound back for a text with no blank line at all', () => {
        // The control: a splitter that returned nothing here would draw an
        // empty answer, and every assertion above would still pass.
        expect(paragraphBoundsOf(codePointsOf('uma linha so'))).toEqual([[0, 12]]);
    });

    it('ignores a bracket that is not a marker', () => {
        // Prose can contain brackets. A walk that accepted `[abc]` would eat
        // the text around it and hand the chip a NaN.
        const points = codePointsOf('o artigo [sic] diz [2].');
        expect(markersIn(points, 0, points.length)).toEqual([{ start: 19, end: 22, marker: 2 }]);
    });
});

describe('the bench can point at what rests on nothing', () => {
    it('returns the stretches no span covers', () => {
        const gaps = unsupportedRanges(20, [{ start: 5, end: 10 }]);
        expect(gaps).toEqual([
            { start: 0, end: 5 },
            { start: 10, end: 20 },
        ]);
    });

    it('returns nothing when the whole text is supported', () => {
        expect(unsupportedRanges(10, [{ start: 0, end: 10 }])).toEqual([]);
    });

    it('returns the whole text when nothing is', () => {
        // The case the screen shows most often on a first try: an answer the
        // corpus does not back at all.
        expect(unsupportedRanges(8, [])).toEqual([{ start: 0, end: 8 }]);
    });

    it('does not invent a gap between spans that touch or overlap', () => {
        // Coalescence and paragraph mode both produce spans that meet, and a
        // zero-width gap between them would underline a dash of nothing —
        // visible, and wrong about what the attribution said.
        expect(unsupportedRanges(10, [{ start: 0, end: 5 }, { start: 5, end: 10 }])).toEqual([]);
        expect(unsupportedRanges(10, [{ start: 0, end: 7 }, { start: 3, end: 10 }])).toEqual([]);
    });

    it('reads spans that arrive out of order', () => {
        // `formatAttribution` returns them in order today. Sorting here costs
        // one pass and removes a dependency on that staying true, which the
        // caller cannot check.
        expect(unsupportedRanges(12, [{ start: 8, end: 12 }, { start: 0, end: 4 }])).toEqual([
            { start: 4, end: 8 },
        ]);
    });
});

describe('the switch is what decides whether a question leaves the machine', () => {
    // The bug this covers: search and grounding both read `denseArm ===
    // 'ready'` and nothing else, so with the arm up a question went to the
    // provider while the note under the switch read "Nothing leaves your
    // machine." The screen made a promise the code did not keep.
    it('keeps the question local while the switch is off, even with the arm up', () => {
        expect(providerMayBeAsked(false, true, 'ready')).toBe(false);
    });

    it('lets it through only when all three hold', () => {
        expect(providerMayBeAsked(true, true, 'ready')).toBe(true);
    });

    it('refuses with no provider, whatever the switch says', () => {
        expect(providerMayBeAsked(true, false, 'ready')).toBe(false);
    });

    it('refuses an arm carrying vectors no live provider matches', () => {
        // `needs-provider` is vectors without the provider that built them:
        // asking anyway would compare this query against numbers from another
        // model, which returns a ranking rather than an error.
        expect(providerMayBeAsked(true, true, 'needs-provider')).toBe(false);
        expect(providerMayBeAsked(true, true, 'absent')).toBe(false);
    });
});

describe('the bench cuts text where the library would', () => {
    it('does not split a character in half', () => {
        // 𝒳 is one code point and two UTF-16 units, so `text.slice(0, 5)` ends
        // inside it and renders a replacement glyph — in a package whose first
        // promise is that it never loses a character.
        const text = 'ab𝒳cd efgh';
        const cut = snippetOf(hit(text), 5);

        expect(cut).toBe('ab𝒳cd…');
        expect([...cut]).toHaveLength(6);
        // The naive version, for contrast: this is what the assertion above
        // exists to keep out. Without it, a passing test proves only that
        // some string came back.
        expect(text.slice(0, 5)).not.toBe('ab𝒳cd');
    });

    it('leaves a short chunk alone rather than marking it truncated', () => {
        expect(snippetOf(hit('short'), 40)).toBe('short');
    });
});

describe('the bench carries the page number and never the page', () => {
    it('passes `pageNumber` through, and undefined when there is none', () => {
        expect(resultForScreen(hit('x', 7), 10).pageNumber).toBe(7);
        expect(resultForScreen(hit('x'), 10).pageNumber).toBeUndefined();
    });
});

describe('the bench reads the rung counts without lying about them', () => {
    /**
     * @param {Partial<import('../../dist/index.js').RungCounts>} rungs
     * @param {import('../../dist/index.js').ProviderFailure} [failure]
     * @returns {import('../../dist/index.js').Attribution}
     */
    function attribution(rungs, failure) {
        const counts = { lexical: 0, vetoed: 0, dense: 0, unattributed: 0, ...rungs };
        const base = { text: 'x', spans: [], sources: [], rungs: counts };
        return failure === undefined ? base : { ...base, providerFailure: failure };
    }

    it('keeps `vetoed` out of the partition', () => {
        // `lexical + dense + unattributed` partition the clauses examined;
        // `vetoed` crosses the last two and never the first, so adding all
        // four counts some clauses twice.
        // 5 + 2 + 4, deliberately not 6 + 2 + 4: with a 6 the expected 12 is
        // also `lexical * 2`, so an implementation that ignored the other two
        // rungs would pass.
        const read = describeRungs(attribution({ lexical: 5, dense: 2, unattributed: 4, vetoed: 3 }), true);
        expect(read.examined).toBe(11);
        expect(read.vetoed).toBe(3);
    });

    it('says the rung never ran when no provider was supplied', () => {
        const read = describeRungs(attribution({ lexical: 3, unattributed: 2 }), false);
        expect(read.note).toContain('did not run: no provider');
        expect(read.retryWorthOffering).toBe(false);
    });

    it('never asks for a key when the failure says one was already used', () => {
        // The defect this guards: `rungs.dense === 0` is produced both by an
        // absent provider and by one that failed, and the library carries
        // `providerFailure` precisely because that degradation is otherwise
        // silent. Reading the count alone tells someone to supply a key they
        // supplied already.
        const failed = attribution({ lexical: 3, dense: 0, unattributed: 2 }, {
            reason: 'quota',
            retryable: true,
            cause: new Error('429'),
        });
        const read = describeRungs(failed, true);

        expect(read.dense).toBe(0);
        expect(read.note).toContain('tried and failed');
        expect(read.note).not.toContain('no provider');
        expect(read.retryWorthOffering).toBe(true);
    });

    it('does not offer a retry the status says is pointless', () => {
        const failed = attribution({}, { reason: 'auth', retryable: false, cause: new Error('401') });
        expect(describeRungs(failed, true).retryWorthOffering).toBe(false);
    });
});

describe('the sentence the screen shows adds up', () => {
    /** @param {Partial<import('../../dist/index.js').RungCounts>} rungs */
    const read = (rungs) =>
        describeRungs(
            {
                text: 'x',
                spans: [],
                sources: [],
                rungs: { lexical: 0, vetoed: 0, dense: 0, unattributed: 0, ...rungs },
            },
            true,
        );

    it('prints every rung, so the numbers reconstruct what was examined', () => {
        // The defect this exists for: with no provider `dense` is always zero
        // and a sentence that omits it looks exact. The first provider makes
        // it reachable and the printed numbers stop summing, with nothing on
        // screen to say where the rest went.
        const counts = read({ lexical: 5, dense: 3, unattributed: 2 });
        const sentence = rungSentence(counts);
        const numbers = (sentence.match(/\d+/g) ?? []).map(Number);

        expect(counts.examined).toBe(10);
        expect(sentence).toContain('10 clause(s) examined');
        const rungs = numbers.slice(1, 4);
        expect(rungs).toEqual([5, 3, 2]);
        expect(rungs.reduce((a, b) => a + b, 0)).toBe(counts.examined);
    });

    it('keeps markers and vetoes out of the sum', () => {
        const sentence = rungSentence(read({ lexical: 4, dense: 0, unattributed: 1, vetoed: 2 }));
        expect(sentence).toContain('crosses the counts rather than adding to them');
    });
});

describe('the corpus survives a reload', () => {
    const restored = new Map([
        ['lei.txt', 'O prazo para a manifestacao e de quinze dias corridos.'],
        ['recursos.md', 'O recurso cabivel contra a decisao final e o agravo.'],
    ]);

    it('rebuilds from the restored texts when nothing was dropped this visit', () => {
        // The defect: a reload repopulates the cache and not the drop list, so
        // reading only the drop list yields an EMPTY corpus — which the
        // library accepts, which a dense build turns into an index reporting
        // itself ready while holding nothing, which then overwrites the good
        // artifact. Empty is the dangerous answer here, not an edge case.
        const docs = corpusFrom([], restored);

        expect(docs).toHaveLength(2);
        expect(docs.map((d) => d.id).sort()).toEqual(['lei.txt', 'recursos.md']);
        expect(() => buildLexicalIndex(docs)).not.toThrow();
        expect(buildLexicalIndex(docs).searchLexical('agravo')[0]?.chunk.documentId).toBe('recursos.md');
    });

    it('does not duplicate a document dropped again this visit', () => {
        const dropped = [documentFromFile('lei.txt', 'texto novo desta visita')];
        const docs = corpusFrom(dropped, restored);

        expect(docs).toHaveLength(2);
        expect(docs.find((d) => d.id === 'lei.txt')?.text).toBe('texto novo desta visita');
    });

    it('keeps one document per id, even dropped twice in the same visit', () => {
        // Found in the browser, not by reading: a restore puts the cached
        // documents back and dropping the same file again appended a second
        // copy. Two identical passages tie on the lexical rung, the veto
        // refuses a tied winner, and the clause comes back with NO marker —
        // the screen showed the answer as though nothing supported it, with
        // no error anywhere.
        const first = documentFromFile('lei.txt', 'versao antiga');
        const again = documentFromFile('lei.txt', 'versao nova');
        const docs = corpusFrom([first, again], new Map());

        expect(docs).toHaveLength(1);
        // The last one wins: a file dropped again is the one meant.
        expect(docs[0]?.text).toBe('versao nova');
    });

    it('attributes a clause when the same file arrives twice in one visit', () => {
        // **The duplicate has to be in `dropped` itself**, which is where it
        // really comes from: `restore` pushes every cached document in, and a
        // re-drop of the same file pushes it again. The earlier version of
        // this case put one copy in `dropped` and one in `restoredTexts`, and
        // the OLD code already skipped that one — measured: one document and
        // one span either way, so the case was green before the fix and after
        // it, proving nothing.
        //
        // With both copies in `dropped`, the old code returned two documents
        // and the attribution returned ZERO spans: two identical passages tie
        // on the lexical rung, the veto refuses a tied winner, and the clause
        // comes back with no marker at all.
        const text = 'O prazo para a manifestacao e de quinze dias corridos.';
        const doc = documentFromFile('lei.txt', text);
        const docs = corpusFrom([doc, doc], new Map());
        const index = buildLexicalIndex(docs);
        const answer = 'O prazo e de quinze dias corridos.';
        const attributed = attributeWithoutKey(answer, index.searchLexical(answer), 'cluster');

        expect(docs).toHaveLength(1);
        expect(attributed.spans).toHaveLength(1);
        expect(markedAnswer(attributed).text).toContain('[1]');
    });

    // REMOVED: `'adds what was typed, and only once'`. It pinned a third
    // source of documents — text pasted into a field on the page — and that
    // screen is gone: the two text areas the bench has now are the composer
    // that grounds an answer and the one that asks a question, and neither
    // feeds the corpus. The parameter it tested was passed `''` at both call
    // sites, so the case was green over a path nothing could reach. §5 says a
    // test whose behaviour stopped existing is removed with the reason, and
    // this is the reason.
});

describe('the bench attributes an answer with no key at all', () => {
    const SOURCE =
        'O prazo para a manifestacao e de quinze dias corridos. ' +
        'A contagem exclui o dia do inicio e inclui o do vencimento. ' +
        'O recurso cabivel contra a decisao final e o agravo.';

    it('marks a clause the source supports, and lists what supports it', () => {
        const index = buildLexicalIndex([documentFromPastedText(SOURCE, 'lei')]);
        const answer = 'O prazo para a manifestacao e de quinze dias corridos.';
        const attributed = attributeWithoutKey(answer, index.searchLexical(answer), 'cluster');

        // Measured, then pinned. `toBeGreaterThan(0)` would pass on any
        // number and the case already pins the CONTENT of the first element
        // below — conferring what is inside a list while leaving how many
        // there are unstated is the half that drifts.
        expect(attributed.spans).toHaveLength(1);
        expect(attributed.sources).toHaveLength(1);
        expect(attributed.rungs.dense).toBe(0);

        const marked = markedAnswer(attributed);
        // The formatter wrote markers in, so the text is no longer the input.
        expect(marked.text).not.toBe(answer);
        expect(marked.text).toContain('[1]');
        expect(marked.sources[0]?.marker).toBe(1);
        expect(marked.sources[0]?.documentId).toBe('lei');
    });

    it('counts clauses and markers separately, because coalescence merges them', () => {
        // Measured on this fixture: two clauses find support and ONE marker is
        // written, because both rest on the same passage. A screen that reads
        // `rungs.lexical` and calls it markers sends the reader looking for a
        // second one that was never written.
        const index = buildLexicalIndex([documentFromPastedText(SOURCE, 'lei')]);
        const answer = 'O prazo e de quinze dias corridos. O recurso cabivel e o agravo.';
        const attributed = attributeWithoutKey(answer, index.searchLexical(answer), 'cluster');
        const counts = describeRungs(attributed, false);

        expect(counts.lexical).toBe(2);
        expect(counts.markers).toBe(1);
        expect(markedAnswer(attributed).text.match(/\[\d+\]/g)).toHaveLength(counts.markers);
    });

    it('costs no network, which is what makes it the no-key half', () => {
        // `attributeLexical` is synchronous. A version that reached the
        // network could not be, and the signature is the proof: there is no
        // promise to await.
        const index = buildLexicalIndex([documentFromPastedText(SOURCE, 'lei')]);
        const returned = attributeWithoutKey('O recurso cabivel e o agravo.', index.searchLexical('recurso agravo'), 'cluster');
        expect(returned).not.toBeInstanceOf(Promise);
        expect(returned.providerFailure).toBeUndefined();
    });

    it('anchors a block at its end where it anchors each clause in place', () => {
        // The switch over the answer promises this in words — "One marker per
        // block" against "One marker per sentence" — and it promised it while
        // the bench passed neither value and both modes drew the same markers.
        // Two clauses in one block is the smallest text where the two answers
        // differ, so it is the one that can fail when the option stops
        // travelling.
        // Two documents rather than one, because coalescence merges adjacent
        // clauses resting on the SAME passage: with a single source both modes
        // draw one marker and the case would pass without the option ever
        // travelling. Separate passages are what makes the two answers differ.
        const index = buildLexicalIndex([
            documentFromPastedText('O prazo para a manifestacao e de quinze dias corridos.', 'prazos'),
            documentFromPastedText('O recurso cabivel contra a decisao final e o agravo.', 'recursos'),
        ]);
        const answer = 'O prazo e de quinze dias corridos. O recurso cabivel e o agravo.';
        const hits = index.searchLexical(answer);

        const perClause = markedAnswer(attributeWithoutKey(answer, hits, 'cluster')).text;
        const perBlock = markedAnswer(attributeWithoutKey(answer, hits, 'paragraph')).text;

        // Both carry two sources — `paragraph` is collective, not sparser —
        // so counting markers proves nothing. Where they sit is the whole
        // difference: every marker at the end of the block against one beside
        // each clause it supports. Measured by position rather than by a
        // literal, so a change in how the formatter spells a marker does not
        // read as a change in where the library anchors it.
        /** @param {string} text */
        const secondClause = (text) => text.indexOf('O recurso');
        expect(perClause.indexOf('[')).toBeLessThan(secondClause(perClause));
        expect(perBlock.indexOf('[')).toBeGreaterThan(secondClause(perBlock));
    });
});

describe('the bench decides what it can read by extension', () => {
    it('accepts the two it reads and refuses the rest', () => {
        expect(looksReadable('lei.txt')).toBe(true);
        expect(looksReadable('notas.md')).toBe(true);
        expect(looksReadable('apostila.pdf')).toBe(false);
        expect(looksReadable('planilha.xlsx')).toBe(false);
    });

    it('ignores case, because a file picker does not normalise it', () => {
        expect(looksReadable('LEI.TXT')).toBe(true);
        expect(looksReadable('Notas.Md')).toBe(true);
    });

    it('does not match a name that merely contains the extension', () => {
        // `.txt` in the middle of a name is not a text file, and a bare
        // `includes` would say it is.
        expect(looksReadable('nota.txt.pdf')).toBe(false);
        expect(looksReadable('arquivo.md.zip')).toBe(false);
    });

    it('makes the file name the id, because nowhere else can hold it', () => {
        // `SourceDoc` carries no title and no URL — removed on purpose, so the
        // library can never put a wrong name in a citation. The id is the only
        // handle the bench gets back on a result.
        const doc = documentFromFile('lei-8078.txt', 'texto qualquer');
        expect(doc.id).toBe('lei-8078.txt');
        expect(Object.keys(doc).sort()).toEqual(['id', 'text']);
    });

    it('finds a passage under the file name it was dropped with', () => {
        const index = buildLexicalIndex([
            documentFromFile('prazos.md', 'O prazo para a manifestacao e de quinze dias corridos.'),
            documentFromFile('recursos.md', 'O recurso cabivel contra a decisao final e o agravo.'),
        ]);
        const hits = index.searchLexical('agravo');

        expect(hits[0]?.chunk.documentId).toBe('recursos.md');
    });
});

describe('the bench, not the library, decides which arm a page takes', () => {
    const PROSE =
        'A contagem do prazo exclui o dia do inicio e inclui o do vencimento, ' +
        'conforme a regra geral aplicavel aos atos processuais.';
    /** @type {import('../../dist/index.js').PageImage} */
    const IMAGE = { data: 'aGVsbG8=', mimeType: 'image/png' };

    it('sends a page of prose down the text arm and keeps the image out of it', () => {
        const doc = pageToDocument('apostila.pdf', { pageNumber: 3, text: PROSE, image: IMAGE });
        expect(doc?.text).toBe(PROSE);
        expect(doc?.pageNumber).toBe(3);
        expect(doc?.page).toBeUndefined();
    });

    it('sends a page whose text layer is debris down the image arm', () => {
        // The direction of the error is the whole design: accepting debris as
        // usable text would put dirty terms in the index AND keep the image
        // out, leaving the page unreachable by either arm.
        const debris = '. , ;; ~ ^ ... 1 |I| :: -- ' .repeat(4);
        const doc = pageToDocument('scan.pdf', { pageNumber: 1, text: debris, image: IMAGE });

        expect(doc?.text).toBe('');
        expect(doc?.page).toEqual(IMAGE);
    });

    it('counts letters, not characters', () => {
        // Sixty characters of punctuation is not sixty letters, and a page of
        // scanner noise is mostly punctuation.
        const noise = '.'.repeat(400);
        expect(hasUsableText(noise)).toBe(false);
        expect(noise.length).toBeGreaterThan(MIN_USABLE_LETTERS);
    });

    it('skips a page with neither usable text nor an image', () => {
        // A `SourceDoc` with empty text and no image would take a slot and
        // match nothing. Returning null says so instead.
        expect(pageToDocument('x.pdf', { pageNumber: 9, text: '   ' })).toBeNull();
    });

    it('produces a document the library actually accepts', () => {
        // The real contract, and the reason this assertion is a build rather
        // than a shape check: `assertNotBothArms` throws on a doc carrying an
        // image AND text, so the routing is only correct if `createIndex`
        // takes what it produced.
        const docs = [
            pageToDocument('mixed.pdf', { pageNumber: 1, text: PROSE, image: IMAGE }),
            pageToDocument('mixed.pdf', { pageNumber: 2, text: '. . .', image: IMAGE }),
        ].filter((d) => d !== null);

        expect(docs).toHaveLength(2);
        expect(() => buildLexicalIndex(docs)).not.toThrow();
    });

    it('keeps the rejected text out of the lexical index', () => {
        // Not merely "the image went in" — the junk must be absent. A routing
        // that stored both would still pass the assertion above.
        const debris = 'zzqqx '.repeat(3);
        const docs = [pageToDocument('scan.pdf', { pageNumber: 1, text: debris, image: IMAGE })].filter(
            (d) => d !== null,
        );
        const index = buildLexicalIndex(docs);

        expect(index.searchLexical('zzqqx')).toEqual([]);
    });

    it('tells a PDF apart from a file merely named like one', () => {
        expect(isPdf('apostila.pdf')).toBe(true);
        expect(isPdf('APOSTILA.PDF')).toBe(true);
        expect(isPdf('apostila.pdf.txt')).toBe(false);
    });
});

describe('a refused artifact does not get one blanket answer', () => {
    /**
     * A real artifact, then damaged one way at a time. Provoking the refusals
     * from `loadIndex` itself is the whole point: a fixture holding strings
     * copied from the source would keep passing after the library reworded
     * them, which is precisely when the classifier is wrong.
     *
     * @param {(artifact: any) => any} damage
     * @param {{ tokenizer?: any, provider?: any }} [opts]
     * @returns {unknown}
     */
    function refusalFrom(damage, opts) {
        const artifact = buildLexicalIndex([
            documentFromPastedText('O prazo para a manifestacao e de quinze dias corridos.', 'lei'),
        ]).serialize();
        try {
            loadIndex(damage(structuredClone(artifact)), opts ?? {});
        } catch (error) {
            return error;
        }
        throw new Error('loadIndex accepted the damaged artifact; the probe proves nothing');
    }

    it('rebuilds for a stale format version, which is free', () => {
        const refusal = refusalFrom((a) => ({ ...a, formatVersion: a.formatVersion + 1 }));
        const verdict = classifyLoadFailure(refusal);

        expect(verdict.kind).toBe('stale');
        expect(verdict.discard).toBe(true);
    });

    it('rebuilds for a different tokenizer', () => {
        const refusal = refusalFrom((a) => ({ ...a, tokenizerId: 'some-other-tokenizer' }));
        expect(classifyLoadFailure(refusal).kind).toBe('stale');
    });

    it('does NOT discard when only the provider is wrong', () => {
        // The expensive mistake, in money: the vectors are in the artifact and
        // a matching provider turns the arm on. `DenseArm`'s docblock names
        // collapsing this case with the others — it "offers 're-read 40
        // documents' to someone who only had to supply a key".
        const refusal = refusalFrom(
            (a) => ({ ...a, dense: { providerId: 'gemini-embedding-2', dimensions: 1536, vectors: '' } }),
            { provider: { id: 'openai-text-3-small', dimensions: 1536, modalities: ['text'], embed: async () => [] } },
        );
        const verdict = classifyLoadFailure(refusal);

        expect(verdict.kind).toBe('provider');
        expect(verdict.discard).toBe(false);
    });

    it('does NOT discard when only the dimensions disagree', () => {
        const refusal = refusalFrom(
            (a) => ({ ...a, dense: { providerId: 'p', dimensions: 1536, vectors: '' } }),
            { provider: { id: 'p', dimensions: 768, modalities: ['text'], embed: async () => [] } },
        );
        const verdict = classifyLoadFailure(refusal);

        expect(verdict.kind).toBe('provider');
        expect(verdict.discard).toBe(false);
    });

    it('calls a damaged posting a broken cache, not a changed provider', () => {
        // Same action as `stale` — discard — but a different sentence. Telling
        // someone their provider changed when their browser storage was
        // damaged sends them chasing the wrong thing.
        const refusal = refusalFrom((a) => {
            const term = Object.keys(a.postings)[0];
            if (term === undefined) throw new Error('the fixture produced no postings to damage');
            return { ...a, postings: { ...a.postings, [term]: [[a.chunks.length + 5, 1]] } };
        });
        const verdict = classifyLoadFailure(refusal);

        expect(verdict.kind).toBe('corrupt');
        expect(verdict.discard).toBe(true);
    });

    it('calls a non-positive frequency a broken cache, like the posting it rides with', () => {
        // The eighth refusal. Without this probe it classified correctly only
        // by accident: it shares the `the posting for` opening with the
        // out-of-range case, which IS probed — so a rewording of one and not
        // the other would drop this into `unknown` with nothing to say so.
        // That accident is exactly what provoking the refusals is supposed to
        // rule out, and it was the one of the eight left standing.
        const refusal = refusalFrom((a) => {
            const term = Object.keys(a.postings)[0];
            if (term === undefined) throw new Error('the fixture produced no postings to damage');
            return { ...a, postings: { ...a.postings, [term]: [[0, 0]] } };
        });
        const verdict = classifyLoadFailure(refusal);

        expect(verdict.message).toContain('occurrences');
        expect(verdict.kind).toBe('corrupt');
        expect(verdict.discard).toBe(true);
    });

    it('calls a malformed dense section a broken cache', () => {
        const refusal = refusalFrom((a) => ({ ...a, dense: { providerId: 7, dimensions: 'x', vectors: null } }), {
            provider: { id: 'p', dimensions: 1536, modalities: ['text'], embed: async () => [] },
        });
        expect(classifyLoadFailure(refusal).kind).toBe('corrupt');
    });

    it('calls a vector count that does not match the chunks a broken cache', () => {
        // The eighth refusal, and the one branch of the classifier no other
        // case here reaches. A pattern nothing provokes is a pattern nothing
        // checked. TWO vectors for the fixture's ONE chunk: one vector would
        // match, and `loadIndex` would accept the artifact — which the helper
        // reports rather than letting the assertion pass on a refusal that
        // never happened.
        const refusal = refusalFrom(
            (a) => ({ ...a, dense: { providerId: 'p', dimensions: 2, vectors: packVectors([[1, 0], [0, 1]]) } }),
            { provider: { id: 'p', dimensions: 2, modalities: ['text'], embed: async () => [] } },
        );
        const verdict = classifyLoadFailure(refusal);

        expect(verdict.message).toContain('vectors for');
        expect(verdict.kind).toBe('corrupt');
        expect(verdict.discard).toBe(true);
    });

    it('calls a base64 payload that will not decode a broken cache', () => {
        // The refusal that arrives from UNDERNEATH `loadIndex`: it calls
        // `unpackVectors`, whose errors carry their own prefix and match none
        // of the patterns written for `index-build.ts`. Damaged bytes in
        // browser storage is the case `corrupt` exists for, and it was the one
        // falling into `unknown` — so the bench kept a cache it could never
        // read again and showed the decoder's message as something to think
        // about.
        const refusal = refusalFrom(
            (a) => ({ ...a, dense: { providerId: 'p', dimensions: 2, vectors: 'nao e base64!' } }),
            { provider: { id: 'p', dimensions: 2, modalities: ['text'], embed: async () => [] } },
        );
        const verdict = classifyLoadFailure(refusal);

        expect(verdict.message).toContain('unpackVectors');
        expect(verdict.kind).toBe('corrupt');
        expect(verdict.discard).toBe(true);
    });

    it('refuses to guess on a refusal it does not recognise', () => {
        // Guessing "rebuild" on an unfamiliar message is the expensive guess.
        // The person reads the library's own sentence and decides.
        const verdict = classifyLoadFailure(new Error('loadIndex: something this bench has never seen'));

        expect(verdict.kind).toBe('unknown');
        expect(verdict.discard).toBe(false);
        expect(verdict.message).toContain('never seen');
    });

    it('missing a provider entirely is not a refusal at all', () => {
        // It does not throw: `denseFromArtifact` returns null and the index
        // reports `needs-provider`. Reaching the classifier for this case at
        // all would already be the bug.
        const artifact = buildLexicalIndex([documentFromPastedText('qualquer texto aqui', 'x')]).serialize();
        expect(() => loadIndex(artifact, {})).not.toThrow();
        expect(loadIndex(artifact, {}).denseArm).toBe('absent');
    });
});

describe('the highlight lands where the library said it would', () => {
    it('splits the page into before, lit and after', () => {
        const page = 'antes GRIFADO depois';
        const parts = highlightParts(page, { start: 6, end: 14 });

        expect(parts).toEqual([
            { text: 'antes ', highlighted: false },
            { text: 'GRIFADO ', highlighted: true },
            { text: 'depois', highlighted: false },
        ]);
    });

    it('drops the empty stretch when the chunk starts the page', () => {
        const parts = highlightParts('GRIFADO depois', { start: 0, end: 7 });
        expect(parts).toHaveLength(2);
        expect(parts[0]?.highlighted).toBe(true);
    });

    it('does not drift past an astral character', () => {
        // The failure this guards is silent: `slice` counts UTF-16 units, so
        // every astral character earlier in the page shifts the highlight by
        // one and it lands over the wrong words — still visible, still
        // confident, wrong. A reader trusts a highlight.
        const page = '𝒳𝒴 alvo resto';
        const span = { start: 3, end: 7 };
        const parts = highlightParts(page, span);

        expect(parts.find((p) => p.highlighted)?.text).toBe('alvo');
        // The naive version on the same offsets, for contrast.
        expect(page.slice(span.start, span.end)).not.toBe('alvo');
    });

    it('clamps a span that overran the page instead of throwing', () => {
        const parts = highlightParts('curto', { start: 2, end: 9999 });
        expect(parts.find((p) => p.highlighted)?.text).toBe('rto');
    });

    it('lights the real chunk of a real index, not a hand-written span', () => {
        // The offsets come from the library rather than from this file, which
        // is the only version of this test that proves the two agree.
        const page =
            'O prazo para a manifestacao e de quinze dias corridos. ' +
            'O recurso cabivel contra a decisao final e o agravo.';
        const index = buildLexicalIndex([documentFromPastedText(page, 'lei')]);
        const found = index.searchLexical('agravo')[0];
        if (found === undefined) throw new Error('the fixture retrieved nothing; the probe proves nothing');

        const lit = highlightParts(page, found.chunk.span).find((p) => p.highlighted)?.text ?? '';
        expect(lit).toBe(found.chunk.text);
        expect(lit).toContain('agravo');
    });

    it('opens a page-image hit whole, with nothing lit', () => {
        // There is no span narrower than the page, so inventing a highlight
        // would be inventing a precision the index does not have.
        const imageHit = { chunk: { id: 'p#0', documentId: 'scan.pdf', text: '', span: { start: 0, end: 0 }, pageNumber: 4 }, score: 1, rank: 1 };
        expect(viewerFor(imageHit, undefined)).toEqual({ kind: 'page' });
    });
});

describe('the key stays on the server side of the provider', () => {
    /**
     * @param {object} answer
     * @param {number} [status]
     */
    function fakeRoute(answer, status = 200) {
        /** @type {any[]} */
        const sent = [];
        /** @type {any} */
        const fetcher = async (/** @type {string} */ url, /** @type {any} */ init) => {
            // The WHOLE request. Capturing only url and body was the defect
            // this helper used to carry: a field dropped here can never fail
            // an assertion downstream, so the test read as a guarantee about
            // the request while measuring a subset of it.
            sent.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
            return { ok: status >= 200 && status < 300, status, json: async () => answer };
        };
        return { fetcher, sent };
    }

    it('asks for documents in one call, not one call per document', () => {
        const { fetcher, sent } = fakeRoute({ vectors: [[1], [2]] });
        const p = remoteProvider({ id: 'x', dimensions: 1, maxInputCodePoints: 100, modalities: ['text'] }, fetcher);

        return p.embedDocuments(['um', 'dois']).then((vectors) => {
            expect(vectors).toEqual([[1], [2]]);
            expect(sent).toHaveLength(1);
            expect(sent[0].url).toBe('/embed');
            expect(sent[0].body).toEqual({ kind: 'documents', texts: ['um', 'dois'] });
            // The verb is contract, not style: `server.mjs` answers /embed on
            // POST alone, so any other method falls through to the static
            // server and comes back 404 — a failure that would surface as
            // "the embedding route answered 404" with nothing pointing here.
            expect(sent[0].method).toBe('POST');
        });
    });

    it('carries the HTTP status into the message, because a retry decision reads a number', () => {
        const { fetcher } = fakeRoute({ error: 'quota' }, 429);
        const p = remoteProvider({ id: 'x', dimensions: 1, maxInputCodePoints: 100, modalities: ['text'] }, fetcher);

        return expect(p.embedQuery('pergunta')).rejects.toThrow('429');
    });

    it('sends exactly one header and two fields, so a key has nowhere to ride', () => {
        // An ALLOWLIST, because a denial list only catches what someone
        // remembered to forbid: `/key|token|secret/i` misses
        // `Authorization: Bearer ...`, which is the commonest shape of all.
        // Enumerating what may travel fails on anything new, named or not.
        //
        // What this does NOT prove, said plainly because the case is named
        // after a guarantee: there is no key in this function's scope to leak.
        // The guarantee lives in `server.mjs`, which holds the key and answers
        // /provider with the shape and never with it.
        const { fetcher, sent } = fakeRoute({ vectors: [[1]] });
        const p = remoteProvider({ id: 'x', dimensions: 1, maxInputCodePoints: 100, modalities: ['text'] }, fetcher);

        return p.embedQuery('pergunta').then(() => {
            expect(Object.keys(sent[0].headers)).toEqual(['content-type']);
            expect(Object.keys(sent[0].body).sort()).toEqual(['kind', 'text']);
        });
    });
});

describe('the dense arm, driven with no network and no key', () => {
    const DOCS = [
        documentFromPastedText('O prazo para a manifestacao e de quinze dias corridos.', 'prazos'),
        documentFromPastedText('O recurso cabivel contra a decisao final e o agravo.', 'recursos'),
    ];

    it('reports `ready` and emits the three build states in order', async () => {
        /** @type {string[]} */
        const seen = [];
        const built = await buildDenseIndex(DOCS, deterministicProvider(64), (event) => seen.push(event.kind));

        expect(built.denseArm).toBe('ready');
        expect(seen).toEqual(['lexical-done', 'embed-start', 'embed-done']);
    });

    it('gives no intermediate signal, which is why the indicator has no percentage', async () => {
        // `embed-done` is one emission and it is terminal — the library says so
        // in `IndexBuildState`. A screen that drew a bar from these events
        // would be drawing a number nobody measured.
        /** @type {string[]} */
        const seen = [];
        await buildDenseIndex(DOCS, deterministicProvider(64), (event) => seen.push(event.kind));

        expect(seen.filter((k) => k === 'embed-done')).toHaveLength(1);
        expect(seen.filter((k) => k === 'embed-start')).toHaveLength(1);
    });

    it('clears the indicator even when the promise rejects after `local-done`', async () => {
        // The trap `attribute`'s own docblock warns about: a chunk wider than
        // the provider's window is checked BEFORE the network, so the promise
        // rejects with `local-done` already emitted. An indicator cleared only
        // on success stays lit forever on that input.
        // Two near-identical passages, so the words cannot separate the clause
        // and it actually reaches the provider. With unrelated documents it
        // resolves lexically, the window is never checked, and the promise
        // resolves — an assertion passing on a rejection that never happened.
        const ambiguous = buildLexicalIndex([
            documentFromPastedText('O prazo e de quinze dias corridos.', 'corridos'),
            documentFromPastedText('O prazo e de quinze dias uteis.', 'uteis'),
        ]);
        const answer = 'O prazo e de quinze dias.';
        const tiny = { ...deterministicProvider(64), maxInputCodePoints: 4 };
        let working = 0;
        let settled = 0;

        await expect(
            attributeWithKey(
                answer,
                ambiguous.searchLexical(answer),
                tiny,
                { onWorking: () => working++, onSettled: () => settled++ },
                'cluster',
            ),
        ).rejects.toThrow();

        expect(working).toBe(1);
        expect(settled).toBe(1);
    });
});

describe('a document the bench assembled reaches the index whole', () => {
    it('finds a passage by a word that is in it', () => {
        const doc = documentFromPastedText(
            'O prazo para a manifestacao e de quinze dias corridos. A contagem exclui o dia do inicio.',
            'pasted',
        );
        const index = buildLexicalIndex([doc]);
        const hits = index.searchLexical('prazo manifestacao');

        expect(hits).toHaveLength(1);
        expect(hits[0]?.chunk.documentId).toBe('pasted');
    });

    it('reports `absent` before anything has been embedded', () => {
        const index = buildLexicalIndex([documentFromPastedText('qualquer texto', 'pasted')]);
        expect(index.denseArm).toBe('absent');
    });
});

describe('markedAnswer and copiedAnswer — the markdown on screen and in the copy', () => {
    // The five `markedAnswer(attribution)` calls above pass no renderable, and
    // that is the path that did not change: `marks` and `blocks` come back
    // empty and the text is what it was. The second parameter is a deliberate
    // extension for the markdown, not a new contract for them.

    const PRAZO = 'O prazo para a manifestacao e de quinze dias corridos.';
    const RECURSO = 'O recurso cabivel contra a decisao final e o agravo.';

    /** @param {string} raw */
    function grounded(raw) {
        const index = buildLexicalIndex([
            documentFromPastedText(PRAZO, 'prazos'),
            documentFromPastedText(RECURSO, 'recursos'),
        ]);
        const renderable = renderableFrom(raw);
        const attribution = attributeWithoutKey(renderable.text, index.searchLexical(renderable.text), 'cluster');
        return { renderable, attribution };
    }

    /** @param {string} text @param {{ start: number, end: number }} s */
    const cut = (text, s) => Array.from(text).slice(s.start, s.end).join('');

    it('without a renderable, nothing about the old answer changes', () => {
        const { attribution } = grounded('O prazo e de quinze dias corridos.');
        const marked = markedAnswer(attribution);
        expect(marked.marks).toEqual([]);
        expect(marked.blocks).toEqual([]);
        expect(copiedAnswer(attribution)).toBe(marked.text);
    });

    it('with no marks the pieces are what the gaps alone cut, which is what it drew before', () => {
        // The equivalence with the drawing before markdown existed: with the
        // gaps as the only ranges, the cuts are exactly the gap boundaries.
        expect(piecesOf(0, 10, [{ start: 3, end: 6 }], [])).toEqual([
            { start: 0, end: 3, kinds: [], gapped: false },
            { start: 3, end: 6, kinds: [], gapped: true },
            { start: 6, end: 10, kinds: [], gapped: false },
        ]);
    });

    it('a gap and a mark that overlap cut each other, and every piece says what covers it', () => {
        expect(piecesOf(0, 10, [{ start: 0, end: 5 }], [{ start: 3, end: 10, kind: 'strong' }])).toEqual([
            { start: 0, end: 3, kinds: [], gapped: true },
            { start: 3, end: 5, kinds: ['strong'], gapped: true },
            { start: 5, end: 10, kinds: ['strong'], gapped: false },
        ]);
    });

    it('a bold stretch lands on the same words once the markers are in', () => {
        const { renderable, attribution } = grounded('O prazo e de **quinze dias** corridos.');
        const marked = markedAnswer(attribution, renderable);
        expect(marked.text).toContain('[1]');
        expect(marked.marks.map((m) => `${m.kind}=${cut(marked.text, m)}`)).toEqual(['strong=quinze dias']);
    });

    it('a heading keeps the marker written at the end of its line', () => {
        // THE CASE THAT TOOK THE BLOCKS OUT OF `carry`. A heading with no
        // closing punctuation gets its marker exactly at the end of the line,
        // where a carried stretch's end does not count it, so a carried
        // heading would come back without its own marker. Measured on the
        // library's path: the marked text read `Título [1]` and the carried
        // stretch `Título`. Found by line number, the heading owns the whole
        // line, marker included.
        const { renderable, attribution } = grounded('## O prazo e de quinze dias corridos\nOutra linha.');
        const marked = markedAnswer(attribution, renderable);
        const lines = marked.text.split('\n');
        expect(lines).toHaveLength(renderable.text.split('\n').length);
        expect(marked.blocks.map((b) => `${b.line}:${b.kind}`)).toEqual(['0:heading']);
        expect(lines[0]).toMatch(/^O prazo e de quinze dias corridos \[\d+\]$/);
    });

    it('a marker at a closing delimiter is copied after it, outside the bold', () => {
        // The round-trip below cannot see this. Taking the marker out gives the
        // raw text back whichever side of `**` it was on, so the side needs an
        // assertion of its own: `left` on the closer keeps the marker outside.
        const { renderable, attribution } = grounded('O prazo e de **quinze dias corridos**.');
        expect(copiedAnswer(attribution, renderable)).toBe('O prazo e de **quinze dias corridos** [1].');
    });

    it('two removals at one point are copied back in the order they had', () => {
        // `## ` and `**` are both taken out at the start of the line. Put back
        // in the wrong order the copy would open `**## `.
        const { renderable, attribution } = grounded('## **O prazo e de quinze dias corridos**');
        expect(copiedAnswer(attribution, renderable)).toBe('## **O prazo e de quinze dias corridos** [1]');
    });

    it('the copy is the markdown that went in, with the markers where the screen has them', () => {
        // The format that goes in is the format that comes out. The markers are
        // taken back out BY POSITION, not by pattern: the raw text already
        // holds a hand-written `, [3]`, which a pattern would eat along with
        // the real markers and pass or fail for the wrong reason.
        const raw = '## O prazo e de quinze dias corridos\nVeja o item, [3] do anexo. **O recurso cabivel e o agravo.**';
        const { renderable, attribution } = grounded(raw);
        const copy = copiedAnswer(attribution, renderable);
        expect(copy).not.toBe(raw);

        // Where each marker group sits in the copy, from the library's own
        // arithmetic: a point either side of every anchor, carried through the
        // markers together with the removals.
        const anchors = [...new Set(attribution.spans.map((s) => s.anchorOffset))];
        const probes = anchors.flatMap((a) => [
            { start: a, end: a, attach: /** @type {const} */ ('left'), probe: 'open' },
            { start: a, end: a, attach: /** @type {const} */ ('right'), probe: 'close' },
        ]);
        const formatted = formatAttribution(attribution, {
            markerStyle: 'bracket',
            carry: [...renderable.removals, ...probes],
        });
        const removals = formatted.carried.filter((c) => !('probe' in c));
        const opens = formatted.carried.filter((c) => 'probe' in c && c.probe === 'open');
        const closes = formatted.carried.filter((c) => 'probe' in c && c.probe === 'close');
        expect(restoreRemovals(formatted.text, /** @type {any} */ (removals))).toBe(copy);

        // A removal at or before a group's start is written before the group;
        // none can fall inside one, because a point lands on one side of an
        // insertion or the other.
        const restoredBefore = (/** @type {number} */ q) =>
            removals.reduce((sum, r) => (r.start <= q ? sum + Array.from(/** @type {any} */ (r).text).length : sum), 0);
        const groups = opens.map((open, i) => {
            const start = open.start + restoredBefore(open.start);
            return { start, end: start + ((closes[i]?.start ?? open.start) - open.start) };
        });
        const points = Array.from(copy);
        for (const g of [...groups].sort((a, b) => b.start - a.start)) points.splice(g.start, g.end - g.start);
        expect(points.join('')).toBe(raw);
    });
});
