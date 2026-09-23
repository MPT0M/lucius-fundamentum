/**
 * The bench's pure half: everything that talks to the library, and nothing
 * that talks to a screen or to Node.
 *
 * It is separate from `app.js` so the tests can reach it. A function that
 * reads `document` is a function no test in this repository can call, and the
 * rules this file encodes — which arm is on, where a snippet may be cut — are
 * exactly the ones worth pinning.
 *
 * **This is where the library's boundary sits.** Above this line the example
 * extracts, stores and renders; below it, the package receives text that is
 * already text. Nothing here opens a binary.
 */

import {
    createIndex,
    createDenseIndex,
    createTokenizer,
    sliceByCodePoints,
    countCodePoints,
    attribute,
    attributeLexical,
    formatAttribution,
    DEFAULT_ATTRIBUTE_OPTIONS,
} from '../../dist/index.js';
import { restoreRemovals } from './markdown.js';

/** @typedef {import('../../dist/index.js').Attribution} Attribution */
/** @typedef {import('./markdown.js').Renderable} Renderable */
/** @typedef {import('./markdown.js').Mark} Mark */
/** @typedef {import('../../dist/index.js').DenseArm} DenseArm */
/** @typedef {import('../../dist/index.js').Index} Index */
/** @typedef {import('../../dist/index.js').RungCounts} RungCounts */
/** @typedef {import('../../dist/index.js').SearchResult} SearchResult */
/** @typedef {import('../../dist/index.js').SourceDoc} SourceDoc */

/**
 * What the screen says about the dense arm, and what it may offer next.
 *
 * The library emits the state and no wording — `IndexBuildState`'s docblock
 * says why: a sentence from the package would be English inside somebody
 * else's interface. So the wording is the bench's, and with it the duty not
 * to collapse the two negative states.
 *
 * `offersEmbedding` is that duty made checkable. `needs-provider` means the
 * vectors are already in the artifact and one argument turns the arm on;
 * `absent` means the corpus was never embedded and reaching hybrid costs
 * money proportional to the collection. Offering "embed everything" for the
 * first is the anti-pattern `DenseArm`'s docblock names: it proposes
 * re-reading 40 documents to someone who only had to supply a key.
 *
 * @param {DenseArm} arm
 * @returns {{ headline: string, detail: string, offersEmbedding: boolean }}
 */
export function describeArm(arm) {
    switch (arm) {
        case 'ready':
            return {
                headline: 'Hybrid search is on.',
                detail: 'Both arms rank every query, and the two lists are fused by reciprocal rank.',
                offersEmbedding: false,
            };
        case 'needs-provider':
            return {
                headline: 'The vectors are here. The provider is not.',
                detail:
                    'This index already carries its vectors. Supply the provider that built them ' +
                    'and the dense arm answers at once — nothing is embedded a second time.',
                offersEmbedding: false,
            };
        case 'absent':
            return {
                headline: 'Lexical only.',
                detail:
                    'This corpus was never embedded. Reaching hybrid means embedding every ' +
                    'document, which costs money and time proportional to the collection.',
                offersEmbedding: true,
            };
    }
}

/**
 * Whether a question may reach the provider.
 *
 * The switch above the composer is a promise written in words: turned off, the
 * note under it reads "Your documents stay on this machine." That promise is a
 * function rather than a condition spelled out at each call site, because it
 * was spelled out and the three sites did not agree — search and grounding both
 * asked the index state directly, so a ready arm answered over the network
 * while the screen said nothing did.
 *
 * The sentence is quoted here and written in `proto-logic.js`, and a guard in
 * `example-scaffold.test.ts` fails when the two stop matching. It already
 * happened once: the note was reworded and this docblock went on quoting the
 * old wording — the line that exists to say the guarantee holds, describing a
 * guarantee the screen had stopped making.
 *
 * All three have to hold. The switch is consent; the provider is whether there
 * is anything to consent to; `ready` is whether the vectors exist, and a
 * `needs-provider` arm carries vectors no live provider matches.
 *
 * @param {boolean} switchedOn what the screen's switch says
 * @param {boolean} hasProvider whether a provider was configured at all
 * @param {DenseArm} arm
 * @returns {boolean}
 */
export function providerMayBeAsked(switchedOn, hasProvider, arm) {
    return switchedOn === true && hasProvider === true && arm === 'ready';
}

/**
 * The id of one page of one file, and the two ways back out of it.
 *
 * A `SourceDoc` id is the only thing the library hands back on a hit, so the
 * bench packs the file name and the page into it and reads them out again —
 * the register, the viewer, the library tile and the cache all key off the
 * same string. The three of them live together because they are one decision:
 * the reader that does not match the writer fails on the first file whose name
 * happens to contain the separator, and it fails by finding nothing rather
 * than by saying so.
 */
const PAGE_MARKER = /#p(\d+)$/;

/**
 * @param {string} fileName
 * @param {number} pageNumber
 * @returns {string}
 */
export function pageIdOf(fileName, pageNumber) {
    return `${fileName}#p${pageNumber}`;
}

/**
 * @param {string} id
 * @returns {string} the file the id belongs to — the id itself when it carries no page
 */
export function fileOfId(id) {
    return id.replace(PAGE_MARKER, '');
}

/**
 * @param {string} id
 * @returns {number | undefined} the page the id carries, if it carries one
 */
export function pageOfId(id) {
    const found = PAGE_MARKER.exec(id);
    return found === null ? undefined : Number(found[1]);
}

/**
 * One document out of a pasted block of text.
 *
 * The id is the bench's to choose, and so is everything else a reader would
 * call metadata. `SourceDoc` is `{ id, text, pageNumber?, page? }` and nothing
 * more — a title, a URL and a file name live in the caller's own register,
 * keyed by this id. The library never learns them, which is why it can never
 * put a wrong one in a citation.
 *
 * @param {string} text
 * @param {string} id
 * @returns {SourceDoc}
 */
export function documentFromPastedText(text, id) {
    return { id, text };
}

/**
 * @param {readonly SourceDoc[]} docs
 * @returns {Index}
 */
export function buildLexicalIndex(docs) {
    return createIndex(docs);
}

/**
 * Which dropped files this bench knows how to read.
 *
 * Extension and not MIME type, and the reason is the file picker rather than
 * taste: a `.md` dragged from a folder arrives with an empty `type` on every
 * browser worth naming, and a `.txt` written by an editor can arrive as
 * `application/octet-stream`. Reading the extension is the thing that behaves
 * the same everywhere.
 */
export const READABLE_TEXT = ['.txt', '.md'];

/**
 * @param {string} name
 * @returns {boolean}
 */
export function looksReadable(name) {
    const lower = name.toLowerCase();
    return READABLE_TEXT.some((ext) => lower.endsWith(ext));
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isPdf(name) {
    return name.toLowerCase().endsWith('.pdf');
}

/**
 * One document out of a dropped file.
 *
 * The file NAME becomes the id, and that is not a shortcut — it is the only
 * place a name can live. `SourceDoc` is `{ id, text, pageNumber?, page? }`;
 * `title`, `sourceUri` and `metadata` were removed from it deliberately,
 * because a library that knows a document's name can put a wrong one in a
 * citation, and one that does not cannot. Whatever else the bench wants to
 * remember about this file — a URL, a display name, the bytes of a page — it
 * keeps in its own register, keyed by this id.
 *
 * @param {string} name
 * @param {string} text
 * @returns {SourceDoc}
 */
export function documentFromFile(name, text) {
    return { id: name, text };
}

/**
 * Every document the bench holds, whatever put it there.
 *
 * Two sources that do not overlap in time: files added this visit, and — after
 * a reload — the texts restored from the cache. **The restored ones are the
 * reason this exists as a rule rather than an expression written twice.** A
 * reload repopulates the cache but not the list of added files, so a caller
 * that reads only that list finds nothing and builds an empty corpus. The
 * library accepts one: `createIndex([])` does not throw and a dense build over
 * it skips the provider entirely, so what comes back reports itself ready while
 * holding nothing — and saving that over a good artifact loses the corpus with
 * no error anywhere.
 *
 * An id already present wins, so a document added this visit is not duplicated
 * by its restored copy.
 *
 * **There were three.** A third source, text pasted straight into a field on
 * the page, went with the screen it belonged to: the two text areas here are
 * the composer that grounds an answer and the one that asks a question, and
 * neither feeds the corpus. The parameter survived the port for a while,
 * passed `''` at both call sites, with a test still pinning it — a path no
 * screen could reach, green.
 *
 * @param {readonly SourceDoc[]} addedThisVisit
 * @param {ReadonlyMap<string, string>} restoredTexts
 * @returns {SourceDoc[]}
 */
export function corpusFrom(addedThisVisit, restoredTexts) {
    /** @type {SourceDoc[]} */
    const docs = [];
    const seen = new Set();

    // **An id appears once.** A restore puts the cached documents back, and
    // dropping the same file again appends a second copy under the same id —
    // and the index accepts it. What follows is silent and hard to read back:
    // two identical passages tie on the lexical rung, the veto refuses a tied
    // winner, the clause goes down a rung, and with no provider it comes back
    // with no marker at all. The screen shows the answer, unmarked, as though
    // nothing supported it. The last copy wins, because a file dropped again
    // is the one the person means.
    for (const doc of addedThisVisit) {
        if (seen.has(doc.id)) docs[docs.findIndex((d) => d.id === doc.id)] = doc;
        else {
            docs.push(doc);
            seen.add(doc.id);
        }
    }

    for (const [id, text] of restoredTexts) {
        if (!seen.has(id) && text !== '') {
            docs.push({ id, text });
            seen.add(id);
        }
    }

    return docs;
}

/**
 * A provider that keeps the key on the other side of a socket.
 *
 * The browser sends text and receives vectors; the server holds the key and
 * calls the real adapter. Nothing here knows which provider is behind it,
 * which is the point — the `.env` decides, and a bench that hard-coded one
 * would be teaching a choice rather than showing one.
 *
 * `id` and `dimensions` come from the server rather than being assumed,
 * because they are what gets written into an artifact and what `loadIndex`
 * later checks. Guessing them here would produce an index that cannot be
 * reloaded.
 *
 * @param {{ id: string, dimensions: number, maxInputCodePoints: number, modalities: readonly import('../../dist/index.js').EmbeddingModality[] }} shape
 * @param {typeof fetch} [fetcher] injected so a test can drive it without a server
 * @returns {import('../../dist/index.js').EmbeddingProvider}
 */
export function remoteProvider(shape, fetcher = fetch) {
    /**
     * @param {object} body
     * @returns {Promise<readonly (readonly number[])[]>}
     */
    async function ask(body) {
        const response = await fetcher('/embed', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            // The STATUS travels in the message, because the rung above reads
            // a number to decide whether a retry is honest and a sentence
            // would tell it nothing.
            throw new Error(`the embedding route answered ${response.status}`);
        }
        const payload = await response.json();
        return payload.vectors;
    }

    return {
        id: shape.id,
        dimensions: shape.dimensions,
        maxInputCodePoints: shape.maxInputCodePoints,
        modalities: shape.modalities,
        embedDocuments: (texts) => ask({ kind: 'documents', texts }),
        embedQuery: async (text) => {
            const vectors = await ask({ kind: 'query', text });
            const first = vectors[0];
            if (first === undefined) throw new Error('the embedding route returned no vector for the query');
            return first;
        },
    };
}

/**
 * Both arms, with progress a screen can show honestly.
 *
 * **The indicator this feeds is indeterminate, and that is the library's
 * design rather than an omission here.** `embed-start` and `embed-done` are
 * one emission each and `embed-done` is terminal — `IndexBuildState` says the
 * `embedded`/`total` pair "is a check on that invariant, not a running count".
 * So these events explain where the time is going; they do not measure it. A
 * percentage drawn from them would be invented.
 *
 * @param {readonly SourceDoc[]} docs
 * @param {import('../../dist/index.js').EmbeddingProvider} provider
 * @param {(event: import('../../dist/index.js').IndexBuildState) => void} onState
 * @returns {Promise<Index>}
 */
export function buildDenseIndex(docs, provider, onState) {
    return createDenseIndex(docs, provider, { onState });
}

/**
 * The full ladder, with the trap its own docblock warns about.
 *
 * `attribute` emits `local-done` ALWAYS — and then either continues to the
 * provider, ends there, or rejects. A chunk wider than the provider's window
 * is checked before the network, so the promise rejects AFTER `local-done` was
 * already emitted: anything a screen hangs on that event has to be cleared by
 * the `catch` as well as by the resolve. `onSettled` exists to make that one
 * place instead of two.
 *
 * The bench does NOT paint the preview that rides on `local-done`. The final
 * result replaces it whole rather than amending it — between the two a marker
 * can move, change number and be fused away — so a consumer that patches
 * marker by marker drifts. Showing "working" and then swapping the block is
 * the version that cannot drift.
 *
 * @param {string} answer
 * @param {readonly SearchResult[]} results
 * @param {import('../../dist/index.js').EmbeddingProvider} provider
 * @param {{ onWorking: () => void, onSettled: () => void }} screen
 * @param {import('../../dist/index.js').AttributionGranularity} granularity what the screen's two-way switch asked for
 * @returns {Promise<Attribution>}
 */
export async function attributeWithKey(answer, results, provider, screen, granularity) {
    try {
        return await attribute(answer, results, {
            ...DEFAULT_ATTRIBUTE_OPTIONS,
            tokenizer: createTokenizer(),
            granularity,
            provider,
            onState: (event) => {
                if (event.kind === 'local-done') screen.onWorking();
            },
        });
    } finally {
        // `finally` and not the resolve path: the rejection above happens with
        // `local-done` already emitted, and an indicator cleared only on
        // success stays lit forever on the input that was too large.
        screen.onSettled();
    }
}

/**
 * What a refused artifact costs to recover from, and it is not one answer.
 *
 * `loadIndex` refuses a stored artifact in ways that do NOT share one
 * recovery, and counting them is the wrong instrument: eight `throw`s live in
 * `index-build.ts` itself, and `unpackVectors` adds more from underneath,
 * reached when the packed vectors are decoded. What matters is the family, not
 * the tally. Two families mean the stored vectors are fine and only the
 * provider is wrong — and throwing those away is the anti-pattern `DenseArm`'s
 * docblock names in money: it "offers 're-read 40 documents' to someone who
 * only had to supply a key".
 *
 * - `stale`  — the artifact was written by a build this one cannot read, or
 *              with a different tokenizer. Rebuilding is free: it is lexical
 *              work over text the bench still has. Discard and reindex.
 * - `corrupt`— the stored bytes are damaged: a posting pointing past the end
 *              of the chunk list, a non-positive frequency, a malformed dense
 *              section, a vector count that does not match, or a base64
 *              payload that will not decode. Nothing to salvage, and the
 *              honest message says the CACHE broke, not that the provider
 *              changed. The decoder's own refusals belong here and were the
 *              last to arrive: damaged bytes in browser storage is literally
 *              the case this family is for, and it was the one the classifier
 *              did not recognise.
 * - `provider`— the vectors are intact and cost money. Do not discard. Ask
 *              for the provider that built them.
 * - `unknown`— a refusal this bench does not recognise. Also not discarded,
 *              deliberately: guessing "rebuild" on an unfamiliar message is
 *              the expensive guess, and a person can read the library's own
 *              sentence and decide.
 *
 * **Classification is by message text, which is fragile, and the test is what
 * makes it honest**: it provokes each refusal from `loadIndex` itself rather
 * than asserting against strings copied into a fixture. When the library
 * rewords one, the test fails here — which is exactly when this function is
 * wrong.
 *
 * @param {unknown} error
 * @returns {{ kind: 'stale' | 'corrupt' | 'provider' | 'unknown', discard: boolean, message: string }}
 */
export function classifyLoadFailure(error) {
    const message = error instanceof Error ? error.message : String(error);

    const says = (/** @type {RegExp} */ pattern) => pattern.test(message);

    if (says(/cannot read format version/) || says(/was given tokenizer/)) {
        return { kind: 'stale', discard: true, message };
    }
    if (says(/was given embedding provider/) || says(/dimensions but the artifact stores/)) {
        return { kind: 'provider', discard: false, message };
    }
    // `vectors for` is a loose fragment — the embedding checks phrase their
    // own errors as "returned N vectors for M inputs" — and it is safe here
    // only because the sole input to this function is what `loadIndex` threw.
    // A second caller would need a narrower pattern.
    // `unpackVectors:` prefixes every refusal the decoder raises — bad
    // dimensions, a length that does not divide, padding-only input, a stray
    // symbol. All of them mean the stored bytes are damaged, which is what
    // `corrupt` is for.
    if (says(/^unpackVectors:/) || says(/the posting for/) || says(/not shaped like one/) || says(/vectors for/)) {
        return { kind: 'corrupt', discard: true, message };
    }
    return { kind: 'unknown', discard: false, message };
}

/**
 * A preview of a hit, cut to a width the screen can hold.
 *
 * **Cut by code points, never by `String.prototype.slice`.** A naive slice
 * counts UTF-16 units, so it splits an emoji or a mathematical letter in half
 * and renders a replacement glyph — in a package whose first promise is that
 * it never loses a character. `sliceByCodePoints` walks code points, so a
 * boundary can never fall inside one, and it clamps instead of throwing.
 *
 * The ellipsis is added only where something was actually removed, so a chunk
 * shorter than the width reads as itself rather than as a truncation.
 *
 * @param {SearchResult} result
 * @param {number} width maximum code points of chunk text to show
 * @returns {string}
 */
export function snippetOf(result, width) {
    const text = result.chunk.text;
    if (countCodePoints(text) <= width) return text;
    return `${sliceByCodePoints(text, 0, width)}…`;
}

/**
 * How many letters a page needs before its text counts as usable.
 *
 * **A demonstration, not a recommendation.** It was never calibrated against a
 * corpus, and copying it into production inherits a decision nobody measured.
 * What is worth copying is the shape: the page decides, the library does not.
 */
export const MIN_USABLE_LETTERS = 60;

/**
 * Whether this page's extracted text is worth indexing as text.
 *
 * **This decision belongs to the caller, and the library refuses to make it.**
 * `assertNotBothArms` treats a `SourceDoc` carrying both a page image and text
 * as an error rather than guessing which one was meant — so somebody has to
 * choose, and it is whoever opened the file.
 *
 * **The error has a direction, which is why the threshold sits high.** Being
 * lenient is worse than being strict: accepting OCR debris as usable text puts
 * dirty terms in the index AND keeps the image out, so the page becomes
 * unreachable by either arm. Being too strict costs one page a lexical route
 * it might have had — the image still indexes, and the page is still findable.
 *
 * Letters rather than characters, because a scanned page's text layer is
 * mostly punctuation and stray marks when it is junk, and a page of real prose
 * is mostly letters.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasUsableText(text) {
    return (text.match(/\p{L}/gu) ?? []).length >= MIN_USABLE_LETTERS;
}

/**
 * One page, routed to the arm it can actually reach.
 *
 * The image passed here is the one bound for the LIBRARY. The bench keeps its
 * own copy of every page for the viewer regardless — that is what makes the
 * page appear beside a hit — and the two are different jobs: an artifact that
 * stored page bytes would not fit in a browser, and a viewer that could only
 * show pages the library happened to index would be a viewer with holes.
 *
 * Returns `null` for a page with neither usable text nor an image, which is a
 * page nothing can index. Skipping it is the honest answer; a `SourceDoc` with
 * an empty text and no image would occupy a slot and match nothing.
 *
 * @param {string} fileName
 * @param {{ pageNumber: number, text: string, image?: import('../../dist/index.js').PageImage }} page
 * @returns {SourceDoc | null}
 */
export function pageToDocument(fileName, page) {
    const id = pageIdOf(fileName, page.pageNumber);
    if (hasUsableText(page.text)) {
        return { id, text: page.text, pageNumber: page.pageNumber };
    }
    if (page.image === undefined) return null;
    // Empty text and not the extracted junk: `assertNotBothArms` refuses a doc
    // carrying both, and the junk is what the threshold above just rejected.
    return { id, text: '', pageNumber: page.pageNumber, page: page.image };
}

/**
 * Which passage supports which stretch of an answer — the sentence the
 * package's own description ends on, and it runs with no key at all.
 *
 * `attributeLexical` is synchronous and touches no network: the two local
 * rungs and nothing else. That is the whole of what works in a browser with
 * no provider configured, and it is the strongest thing this bench can show
 * someone who has not decided to pay for anything yet.
 *
 * @param {string} answer the text to verify, pasted by whoever is at the bench
 * @param {readonly SearchResult[]} results what the search returned for it
 * @param {import('../../dist/index.js').AttributionGranularity} granularity what the screen's two-way switch asked for
 * @returns {Attribution}
 */
export function attributeWithoutKey(answer, results, granularity) {
    return attributeLexical(answer, results, {
        ...DEFAULT_ATTRIBUTE_OPTIONS,
        tokenizer: createTokenizer(),
        granularity,
    });
}

/**
 * The rung counts as one sentence, and it has to ADD UP.
 *
 * It is here rather than in the wiring because it is a decision, not a format
 * string: which numbers appear decides whether a reader can reconstruct the
 * whole. Leaving `dense` out is what broke it once — with no provider it is
 * always zero and the line looked exact, and the moment a provider made it
 * reachable the printed numbers stopped summing to `examined`, with nothing to
 * explain where the rest went.
 *
 * `markers` is stated apart from the rungs, because coalescence merges
 * adjacent clauses resting on the same passage and it is not a fourth term of
 * the sum. `vetoed` is apart for the opposite reason: it crosses two of the
 * three and adding it would count clauses twice.
 *
 * @param {ReturnType<typeof describeRungs>} counts
 * @returns {string}
 */
export function rungSentence(counts) {
    return (
        `${counts.examined} clause(s) examined — ${counts.lexical} on the words, ` +
        `${counts.dense} on the vectors, ${counts.unattributed} none, ` +
        `shown as ${counts.markers} marker(s): adjacent clauses resting on the same passage ` +
        `share one. ${counts.vetoed} winner(s) vetoed, which crosses the counts rather than ` +
        `adding to them. ${counts.note}`
    );
}

/**
 * The answer with its markers written in, and the list they point at.
 *
 * `markerStyle: 'bracket'` because this is the plain-text rendering. Wiring a
 * marker to the viewer that opens a page is possible — the viewer exists — and
 * is NOT done: a marker would have to carry its index into `sources` through
 * `formatted.spans`, which is the coordinate space the paragraph below is
 * about. Said here because the shape of the debt is only visible from this
 * function.
 *
 * The formatter returns its own `spans` rather than the engine's, and the
 * difference is not cosmetic: every offset here is reindexed past the markers
 * just inserted. Mixing the two coordinate spaces is the drift the formatter
 * returns spans to prevent, so a caller that renders from `formatted.text`
 * must read `formatted.spans` and never the originals.
 *
 * The list is composed here, from the bench's own records — the library keeps
 * no title, no URL and no file name, which is exactly why it can never put a
 * wrong one in a citation.
 *
 * `spans` is passed along for the same reason the paragraph above gives for
 * not mixing coordinate spaces: it is what tells a renderer which stretches of
 * THIS text rest on a passage, and therefore which do not. Dropping it left
 * the screen's "unsupported text: marked" setting with nothing to mark.
 *
 * **`renderable` is what the markdown parser took out of the answer**, and it
 * is optional: without it the result is what it always was, with `marks` and
 * `blocks` empty. With it, the style ranges go through `carry`, so they land on
 * the same words once the markers are in. The blocks do not need carrying — a
 * block is a whole line, a marker never holds a newline, and the k-th line of
 * the marked text is the k-th line of the clean one — so they come back as the
 * parser gave them, found by their `line`.
 *
 * @param {Attribution} attribution
 * @param {Renderable | null} [renderable]
 * @returns {{ text: string, spans: readonly { start: number, end: number }[], sources: { marker: number, documentId: string, pageNumber: number | undefined }[], marks: readonly Mark[], blocks: readonly { line: number, kind: import('./markdown.js').BlockKind, level?: number }[] }}
 */
export function markedAnswer(attribution, renderable = null) {
    const formatted = formatAttribution(attribution, { markerStyle: 'bracket', carry: renderable?.marks ?? [] });
    return {
        text: formatted.text,
        // `textSpan` and not `sourceSpan`: one is the clause inside THIS text,
        // the other is the stretch of the source document behind it, and they
        // are offsets into different strings. In formatted coordinates the
        // clause's span already covers the marker written inside it, so the
        // underline never lands on a marker.
        spans: formatted.spans.map((span) => ({ start: span.textSpan.start, end: span.textSpan.end })),
        sources: formatted.sources.map((source, i) => ({
            marker: i + 1,
            documentId: source.chunk.documentId,
            pageNumber: source.chunk.pageNumber,
        })),
        marks: formatted.carried,
        // A block's `start` and `end` are offsets into the CLEAN text, and
        // `text` above is the MARKED one. They are not carried, and the
        // paragraph above says why they do not need to be: a block is found
        // by its `line`. Dropping them here is what keeps two coordinate
        // spaces from meeting in one object.
        blocks: (renderable?.blocks ?? []).map(({ line, kind, level }) =>
            level === undefined ? { line, kind } : { line, kind, level }),
    };
}

/**
 * The answer the copy button puts on the clipboard, before the source list it
 * appends: the markdown the person wrote, with the markers in the places the
 * screen shows them.
 *
 * The format that goes in is the format that comes out. The library grounded
 * the CLEAN text, so the markers are positioned on it; the syntax the parser
 * took out is carried through the markers as points, and put back with the
 * same kind of cursor pass the library uses to write the markers in. Take the
 * markers out of what this returns and what is left is the raw input, code
 * point for code point.
 *
 * Without `renderable` there was no syntax to take out, and the answer is the
 * marked text itself.
 *
 * @param {Attribution} attribution
 * @param {Renderable | null} [renderable]
 * @returns {string}
 */
export function copiedAnswer(attribution, renderable = null) {
    if (renderable === null) return markedAnswer(attribution).text;
    const formatted = formatAttribution(attribution, { markerStyle: 'bracket', carry: renderable.removals });
    return restoreRemovals(formatted.text, formatted.carried);
}

/**
 * The pieces a drawn stretch is cut into, and the only part of that drawing
 * with a rule in it: where to cut, and which ranges cover each cut.
 *
 * Pure, and separate from the DOM for that reason — the suite runs under Node
 * and cannot see an element, but it can see this. A piece is cut wherever a
 * gap or a style range begins or ends inside the stretch, so each one is
 * covered by a fixed set of them: it carries every mark that spans it and the
 * dashed underline when any gap does.
 *
 * @param {number} from
 * @param {number} to
 * @param {readonly { start: number, end: number }[]} gaps
 * @param {readonly { start: number, end: number, kind: 'strong' | 'em' }[]} marks
 * @returns {{ start: number, end: number, kinds: ('strong' | 'em')[], gapped: boolean }[]}
 */
export function piecesOf(from, to, gaps, marks) {
    if (to <= from) return [];
    const edges = new Set([from, to]);
    for (const range of [...gaps, ...marks]) {
        if (range.start > from && range.start < to) edges.add(range.start);
        if (range.end > from && range.end < to) edges.add(range.end);
    }
    const cuts = [...edges].sort((a, b) => a - b);
    /** @type {{ start: number, end: number, kinds: ('strong' | 'em')[], gapped: boolean }[]} */
    const out = [];
    for (let k = 0; k + 1 < cuts.length; k++) {
        const start = /** @type {number} */ (cuts[k]);
        const end = /** @type {number} */ (cuts[k + 1]);
        const covers = (/** @type {{ start: number, end: number }} */ r) => r.start <= start && r.end >= end;
        out.push({ start, end, kinds: marks.filter(covers).map((m) => m.kind), gapped: gaps.some(covers) });
    }
    return out;
}

/**
 * The answer split into code points, which is the unit every offset here uses.
 *
 * **This is the one conversion that makes the rest of the drawing correct.**
 * `formatAttribution` returns offsets in CODE POINTS and says so three times in
 * its own source; JavaScript strings index in UTF-16 code units. They agree
 * until the answer contains one astral character — an emoji, a rare CJK glyph,
 * a mathematical letter — and from that character onward every `slice` lands
 * one position early per astral character before it. The underline for
 * unsupported text would then cover the wrong words while looking exactly as
 * confident as a correct one.
 *
 * An array of code points costs one pass and removes the whole class: after
 * this, `.length` and `.slice` on it mean what the library meant.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function codePointsOf(text) {
    return [...text];
}

/**
 * Every paragraph of the answer as `[start, end)` in code points.
 *
 * A blank line separates paragraphs, which is what the attributor reads as a
 * block boundary too, so the drawing and the attribution agree on where a
 * paragraph ends.
 *
 * @param {readonly string[]} points
 * @returns {[number, number][]}
 */
export function paragraphBoundsOf(points) {
    /** @type {[number, number][]} */
    const bounds = [];
    let start = 0;
    let at = 0;
    while (at < points.length) {
        if (points[at] !== '\n') {
            at += 1;
            continue;
        }
        let run = at;
        while (run < points.length && points[run] === '\n') run += 1;
        // One newline wraps a line; two or more end a paragraph. Below that
        // threshold the break belongs to the paragraph and stays in it.
        if (run - at >= 2) {
            bounds.push([start, at]);
            start = run;
        }
        at = run;
    }
    bounds.push([start, points.length]);
    return bounds;
}

/**
 * The markers `formatAttribution` wrote, located in code points.
 *
 * Found by walking rather than by a regular expression, because a regex reports
 * `index` in code units and mixing the two is the drift this whole file is
 * arranged to avoid. `[`, `]` and the digits are all outside the astral planes,
 * so a walk cannot be confused by the text around them.
 *
 * @param {readonly string[]} points
 * @param {number} from
 * @param {number} to
 * @returns {{ start: number, end: number, marker: number }[]}
 */
export function markersIn(points, from, to) {
    /** @type {{ start: number, end: number, marker: number }[]} */
    const found = [];
    let at = from;
    while (at < to) {
        if (points[at] !== '[') {
            at += 1;
            continue;
        }
        let digits = at + 1;
        while (digits < to && /^[0-9]$/.test(points[digits] ?? '')) digits += 1;
        if (digits > at + 1 && points[digits] === ']') {
            found.push({ start: at, end: digits + 1, marker: Number(points.slice(at + 1, digits).join('')) });
            at = digits + 1;
            continue;
        }
        at += 1;
    }
    return found;
}

/**
 * The stretches of `text` that rest on nothing, as `[start, end)` pairs.
 *
 * The complement of the supported spans, which is what the screen offers to
 * underline. It is computed here rather than in the page because it is
 * arithmetic with an edge — spans arriving unsorted, or touching — and
 * arithmetic with an edge is what a test can hold.
 *
 * @param {number} length how long the text is, IN CODE POINTS
 * @param {readonly { start: number, end: number }[]} supported
 * @returns {{ start: number, end: number }[]}
 */
export function unsupportedRanges(length, supported) {
    const sorted = [...supported].sort((a, b) => a.start - b.start);
    const gaps = [];
    let cursor = 0;
    for (const span of sorted) {
        if (span.start > cursor) gaps.push({ start: cursor, end: span.start });
        cursor = Math.max(cursor, span.end);
    }
    if (cursor < length) gaps.push({ start: cursor, end: length });
    return gaps;
}

/**
 * The rung counts, read out loud — including the one that does not add up.
 *
 * `lexical + dense + unattributed` partition the clauses examined. `vetoed`
 * does not join that sum: it crosses the last two and never the first, because
 * a vetoed winner sends its clause down a rung rather than being replaced by
 * the runner-up. A screen that prints four numbers in a row invites adding
 * them, so `vetoed` is reported apart, and it is the number that answers WHY a
 * stretch ended up unattributed.
 *
 * **`dense === 0` does not read the same way in both states, which is why
 * `providerSupplied` is an argument rather than a guess.** With no provider it
 * means the rung never ran. With one it can also mean the rung ran and every
 * clause had already resolved — or that the provider failed, which the library
 * reports on `providerFailure` precisely because the degradation is otherwise
 * silent: `attribute` does not throw on a provider failure, it degrades, so a
 * `try/catch` around the call never fires. Telling someone to supply a key
 * they already supplied is the failure this branch exists to prevent.
 *
 * **`markers` is not `lexical + dense`, and a screen that prints one and
 * shows the other is lying quietly.** The rungs count CLAUSES, each once;
 * `spans` counts the markers that survive coalescence, which merges adjacent
 * clauses resolving to the same passage into one. A paragraph carrying one
 * marker for four clauses is the library working as designed — but a line
 * reading "4 clauses carried a marker" above a text with one marker in it
 * sends the reader looking for three that were never written.
 *
 * @param {Attribution} attribution
 * @param {boolean} providerSupplied whether a provider was handed to the call
 * @returns {{ examined: number, lexical: number, dense: number, unattributed: number, vetoed: number, markers: number, note: string, retryWorthOffering: boolean }}
 */
export function describeRungs(attribution, providerSupplied) {
    const { lexical, dense, unattributed, vetoed } = attribution.rungs;
    const failure = attribution.providerFailure;

    const note =
        failure !== undefined
            ? `The dense rung was tried and failed (${failure.reason}), so these counts are the ` +
              `local rungs alone.`
            : providerSupplied
              ? 'The dense rung was available. Clauses it did not decide were already resolved locally.'
              : 'The dense rung did not run: no provider. A clause the words cannot separate comes ' +
                'back with no marker here, so coverage in this state is structurally lower than any ' +
                'figure measured with one.';

    return {
        examined: lexical + dense + unattributed,
        lexical,
        dense,
        unattributed,
        vetoed,
        markers: attribution.spans.length,
        note,
        // `retryable` reads the HTTP status, a standardised number, and never
        // the provider's prose, which changes without notice.
        retryWorthOffering: failure?.retryable ?? false,
    };
}

/**
 * A page split into the stretch a chunk covers and the stretches around it.
 *
 * **Cut by code points, because that is the unit `Span` is written in.** A
 * `String.prototype.slice` at the same offsets drifts by one for every astral
 * character earlier in the page, and the drift is silent: the highlight still
 * appears, just over the wrong words. That is worse than no highlight, because
 * a reader trusts it.
 *
 * **And it must be given the SAME text that was indexed.** The span is an
 * offset into what the library received; rendering from a second extraction —
 * another pass of the extractor, a different normaliser, a trimmed copy —
 * moves every offset after the first difference. The bench stores the page
 * text beside the page image at ingest for exactly this reason, rather than
 * re-reading the PDF when a hit is clicked.
 *
 * Empty stretches are dropped, so a chunk at the very start of a page does not
 * produce a leading empty piece for the renderer to reason about. Bounds are
 * clamped by `sliceByCodePoints` rather than thrown, which is what keeps a
 * stale span from breaking the render path.
 *
 * @param {string} pageText the text that was handed to the library
 * @param {import('../../dist/index.js').Span} span
 * @returns {{ text: string, highlighted: boolean }[]}
 */
export function highlightParts(pageText, span) {
    const pieces = [
        { text: sliceByCodePoints(pageText, 0, span.start), highlighted: false },
        { text: sliceByCodePoints(pageText, span.start, span.end), highlighted: true },
        { text: sliceByCodePoints(pageText, span.end), highlighted: false },
    ];
    return pieces.filter((piece) => piece.text !== '');
}

/**
 * What the viewer should show for a hit, which is not the same for both arms.
 *
 * A text chunk has a span, so the page opens with that stretch lit. A page
 * indexed as an image has none — the page IS the unit, there is nothing
 * narrower to point at — so it opens whole, and inventing a highlight for it
 * would be inventing a precision the index does not have.
 *
 * @param {SearchResult} result
 * @param {string | undefined} pageText the text indexed for this document, if any
 * @returns {{ kind: 'text', parts: { text: string, highlighted: boolean }[] } | { kind: 'page' }}
 */
export function viewerFor(result, pageText) {
    if (result.chunk.text === '' || pageText === undefined) return { kind: 'page' };
    return { kind: 'text', parts: highlightParts(pageText, result.chunk.span) };
}

/**
 * What the screen needs about one hit, with the page left as a number.
 *
 * The page IMAGE is never here: the library returns `pageNumber` and the bench
 * looks the page up in what it stored itself. That split is the whole reason
 * an artifact stays small enough to keep in a browser.
 *
 * @param {SearchResult} result
 * @param {number} snippetWidth
 * @returns {{ documentId: string, chunkId: string, pageNumber: number | undefined, snippet: string, score: number }}
 */
export function resultForScreen(result, snippetWidth) {
    return {
        documentId: result.chunk.documentId,
        chunkId: result.chunk.id,
        pageNumber: result.chunk.pageNumber,
        snippet: snippetOf(result, snippetWidth),
        score: result.score,
    };
}
