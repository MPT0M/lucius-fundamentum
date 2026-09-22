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
 * What is worth a test here is not that the page renders. It is the two rules
 * the bench must get right for the library's own promises to survive the trip
 * to a screen: never collapsing the two reasons the dense arm is off, and
 * never cutting text anywhere but a code point boundary.
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
    describeRungs,
    looksReadable,
    documentFromFile,
    isPdf,
    pageToDocument,
    hasUsableText,
    MIN_USABLE_LETTERS,
    classifyLoadFailure,
    highlightParts,
    viewerFor,
    remoteProvider,
    buildDenseIndex,
    attributeWithKey,
} from './bancada.js';
import { loadIndex, packVectors, deterministicProvider } from '../../dist/index.js';

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
        const read = describeRungs(attribution({ lexical: 6, dense: 2, unattributed: 4, vetoed: 3 }), true);
        expect(read.examined).toBe(12);
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

describe('the bench attributes an answer with no key at all', () => {
    const SOURCE =
        'O prazo para a manifestacao e de quinze dias corridos. ' +
        'A contagem exclui o dia do inicio e inclui o do vencimento. ' +
        'O recurso cabivel contra a decisao final e o agravo.';

    it('marks a clause the source supports, and lists what supports it', () => {
        const index = buildLexicalIndex([documentFromPastedText(SOURCE, 'lei')]);
        const answer = 'O prazo para a manifestacao e de quinze dias corridos.';
        const attributed = attributeWithoutKey(answer, index.searchLexical(answer));

        expect(attributed.spans.length).toBeGreaterThan(0);
        expect(attributed.sources.length).toBeGreaterThan(0);
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
        const attributed = attributeWithoutKey(answer, index.searchLexical(answer));
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
        const returned = attributeWithoutKey('O recurso cabivel e o agravo.', index.searchLexical('recurso agravo'));
        expect(returned).not.toBeInstanceOf(Promise);
        expect(returned.providerFailure).toBeUndefined();
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
            sent.push({ url, body: JSON.parse(init.body) });
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
        });
    });

    it('carries the HTTP status into the message, because a retry decision reads a number', () => {
        const { fetcher } = fakeRoute({ error: 'quota' }, 429);
        const p = remoteProvider({ id: 'x', dimensions: 1, maxInputCodePoints: 100, modalities: ['text'] }, fetcher);

        return expect(p.embedQuery('pergunta')).rejects.toThrow('429');
    });

    it('never puts a key in what it sends', () => {
        const { fetcher, sent } = fakeRoute({ vectors: [[1]] });
        const p = remoteProvider({ id: 'x', dimensions: 1, maxInputCodePoints: 100, modalities: ['text'] }, fetcher);

        return p.embedQuery('pergunta').then(() => {
            expect(JSON.stringify(sent[0])).not.toMatch(/key|token|secret/i);
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
            attributeWithKey(answer, ambiguous.searchLexical(answer), tiny, {
                onWorking: () => working++,
                onSettled: () => settled++,
            }),
        ).rejects.toThrow();

        expect(working).toBe(1);
        expect(settled).toBe(1);
    });
});

describe('the bench indexes what was pasted', () => {
    it('finds a passage by a word that is in it', () => {
        const doc = documentFromPastedText(
            'O prazo para a manifestacao e de quinze dias corridos. A contagem exclui o dia do inicio.',
            'pasted',
        );
        const index = buildLexicalIndex([doc]);
        const hits = index.searchLexical('prazo manifestacao');

        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0]?.chunk.documentId).toBe('pasted');
    });

    it('reports `absent` before anything has been embedded', () => {
        const index = buildLexicalIndex([documentFromPastedText('qualquer texto', 'pasted')]);
        expect(index.denseArm).toBe('absent');
    });
});
