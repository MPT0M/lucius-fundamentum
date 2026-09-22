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
    createTokenizer,
    sliceByCodePoints,
    countCodePoints,
    attributeLexical,
    formatAttribution,
    DEFAULT_ATTRIBUTE_OPTIONS,
} from '../../dist/index.js';

/** @typedef {import('../../dist/index.js').Attribution} Attribution */
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
 * What a refused artifact costs to recover from, and it is not one answer.
 *
 * `loadIndex` throws eight different refusals, and they do NOT deserve the
 * same response. Two of them mean the stored vectors are fine and only the
 * provider is wrong — and throwing those away is the anti-pattern `DenseArm`'s
 * docblock names in money: it "offers 're-read 40 documents' to someone who
 * only had to supply a key".
 *
 * - `stale`  — the artifact was written by a build this one cannot read, or
 *              with a different tokenizer. Rebuilding is free: it is lexical
 *              work over text the bench still has. Discard and reindex.
 * - `corrupt`— the stored bytes are damaged: a posting pointing past the end
 *              of the chunk list, a non-positive frequency, a malformed dense
 *              section, a vector count that does not match. Nothing to
 *              salvage, and the honest message says the CACHE broke, not that
 *              the provider changed.
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
    if (says(/the posting for/) || says(/not shaped like one/) || says(/vectors for/)) {
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
    const id = `${fileName}#p${page.pageNumber}`;
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
 * @returns {Attribution}
 */
export function attributeWithoutKey(answer, results) {
    return attributeLexical(answer, results, {
        ...DEFAULT_ATTRIBUTE_OPTIONS,
        tokenizer: createTokenizer(),
    });
}

/**
 * The answer with its markers written in, and the list they point at.
 *
 * `markerStyle: 'bracket'` because this commit renders plain text; the
 * interactive marker belongs with the viewer that can open a page behind it.
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
 * @param {Attribution} attribution
 * @returns {{ text: string, sources: { marker: number, documentId: string, pageNumber: number | undefined }[] }}
 */
export function markedAnswer(attribution) {
    const formatted = formatAttribution(attribution, { markerStyle: 'bracket' });
    return {
        text: formatted.text,
        sources: formatted.sources.map((source, i) => ({
            marker: i + 1,
            documentId: source.chunk.documentId,
            pageNumber: source.chunk.pageNumber,
        })),
    };
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
