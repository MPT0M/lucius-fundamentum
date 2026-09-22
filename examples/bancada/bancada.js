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

import { createIndex, sliceByCodePoints, countCodePoints } from '../../dist/index.js';

/** @typedef {import('../../dist/index.js').DenseArm} DenseArm */
/** @typedef {import('../../dist/index.js').Index} Index */
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
