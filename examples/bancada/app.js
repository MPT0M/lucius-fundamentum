/**
 * The bench's wiring: the half that reads the screen and writes to it.
 *
 * Every decision worth pinning lives in `bancada.js`, which no test can reach
 * if it touches `document`. What is left here is reading fields and appending
 * nodes — deliberately dull, because the dull half is the untested half.
 */

import {
    describeArm,
    documentFromPastedText,
    buildLexicalIndex,
    resultForScreen,
    attributeWithoutKey,
    markedAnswer,
    describeRungs,
    looksReadable,
    documentFromFile,
    READABLE_TEXT,
    isPdf,
    pageToDocument,
    classifyLoadFailure,
    viewerFor,
    remoteProvider,
    buildDenseIndex,
    attributeWithKey,
} from './bancada.js';
import { readPdf } from './pdf.js';
import { save, load, forget, approximateBytes } from './storage.js';
import { loadIndex } from '../../dist/index.js';

/** @typedef {import('../../dist/index.js').Index} Index */
/** @typedef {import('../../dist/index.js').SourceDoc} SourceDoc */

const SNIPPET_WIDTH = 240;

/** @type {Index | null} */
let index = null;

/**
 * The provider, when the server has a key. Null is the ordinary case.
 *
 * @type {import('../../dist/index.js').EmbeddingProvider | null}
 */
let provider = null;

/**
 * Files dropped on the page, in the order they arrived.
 *
 * They are held here and not in the index, because indexing is a separate
 * button: dropping a file should not silently spend the time it takes to chunk
 * and tokenize a long document.
 *
 * @type {SourceDoc[]}
 */
const dropped = [];

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function must(id) {
    const node = document.getElementById(id);
    if (node === null) throw new Error(`the page is missing #${id}`);
    return node;
}

const source = /** @type {HTMLTextAreaElement} */ (must('source'));
const query = /** @type {HTMLInputElement} */ (must('query'));
const arm = must('arm');
const results = must('results');
const status = must('status');

/** @param {string} message */
function say(message) {
    status.textContent = message;
}

function showArm() {
    if (index === null) {
        arm.textContent = '';
        must('embed-button').hidden = true;
        return;
    }
    const state = describeArm(index.denseArm);
    arm.textContent = `${state.headline} ${state.detail}`;
    // Offered for `absent` alone. `needs-provider` is one argument away and
    // offering to embed again there is the mistake this whole field exists to
    // prevent.
    must('embed-button').hidden = !(state.offersEmbedding && provider !== null);
}

/**
 * Asks the server what it has, before the page offers anything that costs.
 *
 * `id` and `dimensions` come from the server rather than being assumed here:
 * they are written into the artifact and checked on every later load, so a
 * guess would produce an index that cannot be reopened.
 */
async function askServerForProvider() {
    try {
        const shape = await (await fetch('/provider')).json();
        if (shape.configured === true) provider = remoteProvider(shape);
    } catch {
        // The bench works without it. A failed probe is not worth a banner.
    }
}

/**
 * Embeds the corpus, which is the one action here that spends money.
 *
 * The indicator is deliberately without a percentage: `embed-start` and
 * `embed-done` are one emission each and `embed-done` is terminal, so the
 * library gives an explanation of where the time is going rather than a
 * running count. Drawing a bar from them would be drawing a number nobody
 * measured.
 */
async function doEmbed() {
    if (index === null || provider === null) return;
    const docs = [...dropped];
    const text = source.value.trim();
    if (text !== '') docs.push(documentFromPastedText(text, 'pasted'));

    must('embed-button').hidden = true;
    try {
        index = await buildDenseIndex(docs, provider, (event) => {
            if (event.kind === 'lexical-done') say(`Lexical index ready: ${event.chunks} chunks. Embedding…`);
            if (event.kind === 'embed-start') say(`Embedding ${event.total} chunk(s). No progress to report until it finishes.`);
            if (event.kind === 'embed-done') say(`Embedded ${event.embedded} of ${event.total}.`);
        });
        showArm();
        void save(index.serialize(), pageImages, docTexts).then(showCacheSize);
    } catch (error) {
        say(`Embedding failed, and the lexical index is untouched. ${error instanceof Error ? error.message : String(error)}`);
        showArm();
    }
}

function showDropped() {
    must('files').replaceChildren(
        ...dropped.map((doc) => {
            const item = document.createElement('li');
            item.textContent = doc.id;
            return item;
        }),
    );
}

async function showCacheSize() {
    const bytes = await approximateBytes();
    must('cache').textContent =
        bytes === null
            ? ''
            : `Cached on this machine: about ${(bytes / 1_000_000).toFixed(1)} MB. ` +
              'Approximate — the browser reports the whole origin, rounded.';
}

function doIndex() {
    const text = source.value.trim();
    /** @type {SourceDoc[]} */
    const docs = [...dropped];
    if (text !== '') docs.push(documentFromPastedText(text, 'pasted'));

    if (docs.length === 0) {
        say('Paste some text or drop a file first.');
        return;
    }
    for (const doc of docs) docTexts.set(doc.id, doc.text);
    index = buildLexicalIndex(docs);
    results.replaceChildren();
    say(`Indexed ${docs.length} document(s). Search below.`);
    showArm();
    void save(index.serialize(), pageImages, docTexts).then(showCacheSize);
}

/**
 * Restores the last index, and answers a refusal with the answer that refusal
 * actually deserves.
 *
 * The expensive branch is `provider`: the vectors are in the artifact and they
 * cost money, so a mismatch is not a reason to throw them away. `discard` says
 * which refusals are free to rebuild from text the bench still holds, and it
 * is false for exactly the ones that are not.
 */
async function restore() {
    const cached = await load();
    if (cached === null) return;

    try {
        index = loadIndex(cached.artifact);
        for (const [id, image] of cached.pages) pageImages.set(id, image);
        for (const [id, text] of cached.texts) docTexts.set(id, text);
        say(`Restored an index from ${new Date(cached.savedAt).toLocaleString()}.`);
        showArm();
    } catch (error) {
        const verdict = classifyLoadFailure(error);
        if (verdict.discard) {
            await forget();
            say(`The cached index could not be read, so it was cleared. ${verdict.message}`);
        } else {
            // Not cleared, and the library's own sentence is shown rather than
            // a paraphrase: it already explains the problem, and rewording it
            // is how a caller starts saying something the library does not.
            say(`The cached index was kept. ${verdict.message}`);
        }
    }
    void showCacheSize();
}

/**
 * Every page the bench has rendered, keyed by the document id the library
 * will report back on a hit.
 *
 * This register is the reason the library never has to carry a page. It
 * returns `documentId` and `pageNumber`; the page itself is looked up here.
 *
 * @type {Map<string, import('../../dist/index.js').PageImage>}
 */
const pageImages = new Map();

/**
 * The text each document was indexed WITH, keyed the same way.
 *
 * The highlight depends on this being the very text the library received. A
 * second extraction — another pass, a different normaliser, a trimmed copy —
 * moves every offset after the first difference, and the highlight then lands
 * on the wrong words while still looking certain.
 *
 * @type {Map<string, string>}
 */
const docTexts = new Map();

/** @param {File} file */
async function takePdf(file) {
    say(`Reading ${file.name}…`);
    const pages = await readPdf(await file.arrayBuffer());

    let asText = 0;
    let asImage = 0;
    for (const page of pages) {
        const doc = pageToDocument(file.name, page);
        if (doc === null) continue;
        // The image is kept for EVERY page, including the ones indexed as
        // text: the viewer has to be able to show any hit's page, not only
        // the pages the library happened to receive an image for.
        pageImages.set(doc.id, page.image);
        dropped.push(doc);
        if (doc.text === '') asImage++;
        else asText++;
    }
    return { asText, asImage, skipped: pages.length - asText - asImage };
}

/** @param {DataTransfer | null} transfer */
async function takeFiles(transfer) {
    const files = [...(transfer?.files ?? [])];
    const rejected = files.filter((file) => !looksReadable(file.name) && !isPdf(file.name));
    let taken = 0;
    let routed = '';

    for (const file of files) {
        if (looksReadable(file.name)) {
            // `File.text()` decodes as UTF-8, which is the bench's assumption
            // and worth saying: a file saved in a legacy encoding arrives
            // mangled here, not in the library.
            dropped.push(documentFromFile(file.name, await file.text()));
            taken++;
        } else if (isPdf(file.name)) {
            const counts = await takePdf(file);
            taken++;
            routed +=
                ` ${file.name}: ${counts.asText} page(s) indexed as text, ${counts.asImage} as images` +
                (counts.skipped === 0 ? '.' : `, ${counts.skipped} skipped with neither.`);
        }
    }
    showDropped();

    // Naming what was refused, rather than dropping it quietly: a file that
    // vanishes on drop reads as a broken page.
    const refused =
        rejected.length === 0
            ? ''
            : ` Ignored ${rejected.map((f) => f.name).join(', ')} — the bench reads ${READABLE_TEXT.join(', ')} and .pdf.`;
    say(`${taken} file(s) ready to index.${routed}${refused}`);
}

document.addEventListener('dragover', (event) => {
    event.preventDefault();
    document.body.classList.add('dragging');
});
document.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
document.addEventListener('drop', (event) => {
    event.preventDefault();
    document.body.classList.remove('dragging');
    void takeFiles(event.dataTransfer);
});

async function doSearch() {
    if (index === null) {
        say('Index something first.');
        return;
    }
    const asked = query.value.trim();
    if (asked === '') return;

    // `search` fuses both arms and refuses while the dense one is not ready;
    // `searchLexical` is the honest call when it is not. Reading `denseArm`
    // rather than trying and catching keeps the failure out of the happy path.
    const found = index.denseArm === 'ready' ? await index.search(asked) : index.searchLexical(asked);
    const hits = found.map((hit) => resultForScreen(hit, SNIPPET_WIDTH));
    results.replaceChildren(
        ...hits.map((hit, i) => {
            const item = document.createElement('li');
            const where = document.createElement('button');
            where.type = 'button';
            where.className = 'where';
            where.textContent =
                hit.pageNumber === undefined
                    ? hit.documentId
                    : `${hit.documentId}, page ${hit.pageNumber}`;
            const source = found[i];
            if (source !== undefined) where.addEventListener('click', () => openViewer(source));
            const body = document.createElement('p');
            body.textContent = hit.snippet;
            item.append(where, body);
            return item;
        }),
    );
    // BM25 scores are comparable only inside one result list, which the count
    // says and the number would not: printing 7.41 beside a hit invites
    // comparing it with a 7.41 from another corpus, where it means something
    // else entirely.
    say(hits.length === 0 ? 'Nothing matched.' : `${hits.length} passage(s), best first.`);
}

/**
 * Opens the document beside the result, with the retrieved stretch lit.
 *
 * A page indexed as an image opens whole and unlit: the page is the unit and
 * there is no narrower span to point at, so a highlight there would be a
 * precision the index does not have.
 *
 * @param {import('../../dist/index.js').SearchResult} result
 */
function openViewer(result) {
    const viewer = must('viewer');
    const text = docTexts.get(result.chunk.documentId);
    const shown = viewerFor(result, text);
    const image = pageImages.get(result.chunk.documentId);

    /** @type {Node[]} */
    const parts = [];
    const caption = document.createElement('p');
    caption.className = 'where';
    caption.textContent =
        result.chunk.pageNumber === undefined
            ? result.chunk.documentId
            : `${result.chunk.documentId}, page ${result.chunk.pageNumber}`;
    parts.push(caption);

    if (image !== undefined) {
        const picture = document.createElement('img');
        picture.src = `data:${image.mimeType};base64,${image.data}`;
        picture.alt = caption.textContent;
        parts.push(picture);
    }

    if (shown.kind === 'text') {
        const body = document.createElement('p');
        body.className = 'page-text';
        body.append(
            ...shown.parts.map((piece) => {
                if (!piece.highlighted) return document.createTextNode(piece.text);
                // An INLINE span, so the colour stops where the text stops.
                // A block with padding paints a rectangle: the last line ends
                // mid-way and the fill runs on to the margin, which does not
                // read as a marker over words.
                const lit = document.createElement('mark');
                lit.textContent = piece.text;
                return lit;
            }),
        );
        parts.push(body);
    } else {
        const note = document.createElement('p');
        note.className = 'note';
        note.textContent = 'Indexed as an image: the page is the unit, so nothing narrower is lit.';
        parts.push(note);
    }

    viewer.replaceChildren(...parts);
}

async function doAttribute() {
    if (index === null) {
        say('Index something first.');
        return;
    }
    const answer = /** @type {HTMLTextAreaElement} */ (must('answer')).value.trim();
    if (answer === '') {
        say('Paste the answer you want to verify.');
        return;
    }

    // The candidates are what the answer itself retrieves. Attribution ranks
    // passages against clauses; it does not go looking for them.
    const usesProvider = provider !== null && index.denseArm === 'ready';
    const candidates = usesProvider ? await index.search(answer) : index.searchLexical(answer);
    const attribution = usesProvider
        ? await attributeWithKey(answer, candidates, /** @type {NonNullable<typeof provider>} */ (provider), {
              onWorking: () => say('Local rungs done. Asking the provider for the rest…'),
              onSettled: () => say('Attributed.'),
          })
        : attributeWithoutKey(answer, candidates);
    const marked = markedAnswer(attribution);
    const counts = describeRungs(attribution, usesProvider);

    must('marked').textContent = marked.text;
    must('sources').replaceChildren(
        ...marked.sources.map((source) => {
            const item = document.createElement('li');
            item.textContent =
                source.pageNumber === undefined
                    ? source.documentId
                    : `${source.documentId}, page ${source.pageNumber}`;
            return item;
        }),
    );
    must('rungs').textContent =
        `${counts.examined} clause(s) examined — ${counts.lexical} found support, ` +
        `${counts.unattributed} none, shown as ${counts.markers} marker(s): adjacent clauses ` +
        `resting on the same passage share one. ${counts.vetoed} winner(s) vetoed, which crosses ` +
        `the counts rather than adding to them. ${counts.note}`;
    say('Attributed.');
}

must('index-button').addEventListener('click', doIndex);
must('attribute-button').addEventListener('click', () => void doAttribute());
must('embed-button').addEventListener('click', () => void doEmbed());
must('forget-button').addEventListener('click', () => {
    void forget().then(() => {
        index = null;
        showArm();
        results.replaceChildren();
        say('Cache cleared. The files on your disk are untouched.');
        return showCacheSize();
    });
});

void askServerForProvider().then(restore);
must('search-button').addEventListener('click', () => void doSearch());
query.addEventListener('keydown', (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === 'Enter') void doSearch();
});
