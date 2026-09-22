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
} from './bancada.js';

/** @typedef {import('../../dist/index.js').Index} Index */
/** @typedef {import('../../dist/index.js').SourceDoc} SourceDoc */

const SNIPPET_WIDTH = 240;

/** @type {Index | null} */
let index = null;

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
        return;
    }
    const state = describeArm(index.denseArm);
    arm.textContent = `${state.headline} ${state.detail}`;
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

function doIndex() {
    const text = source.value.trim();
    /** @type {SourceDoc[]} */
    const docs = [...dropped];
    if (text !== '') docs.push(documentFromPastedText(text, 'pasted'));

    if (docs.length === 0) {
        say('Paste some text or drop a file first.');
        return;
    }
    index = buildLexicalIndex(docs);
    results.replaceChildren();
    say(`Indexed ${docs.length} document(s). Search below.`);
    showArm();
}

/** @param {DataTransfer | null} transfer */
async function takeFiles(transfer) {
    const files = [...(transfer?.files ?? [])];
    const readable = files.filter((file) => looksReadable(file.name));
    const rejected = files.filter((file) => !looksReadable(file.name));

    for (const file of readable) {
        // `File.text()` decodes as UTF-8, which is the bench's assumption and
        // worth saying: a file saved in a legacy encoding arrives mangled here,
        // not in the library.
        dropped.push(documentFromFile(file.name, await file.text()));
    }
    showDropped();

    // Naming what was refused, rather than dropping it quietly: a file that
    // vanishes on drop reads as a broken page.
    const refused =
        rejected.length === 0
            ? ''
            : ` Ignored ${rejected.map((f) => f.name).join(', ')} — this commit reads ${READABLE_TEXT.join(' and ')}.`;
    say(`${readable.length} file(s) ready to index.${refused}`);
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

function doSearch() {
    if (index === null) {
        say('Index something first.');
        return;
    }
    const asked = query.value.trim();
    if (asked === '') return;

    const hits = index.searchLexical(asked).map((hit) => resultForScreen(hit, SNIPPET_WIDTH));
    results.replaceChildren(
        ...hits.map((hit) => {
            const item = document.createElement('li');
            const where = document.createElement('span');
            where.className = 'where';
            where.textContent =
                hit.pageNumber === undefined
                    ? hit.documentId
                    : `${hit.documentId}, page ${hit.pageNumber}`;
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

function doAttribute() {
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
    const candidates = index.searchLexical(answer);
    const attribution = attributeWithoutKey(answer, candidates);
    const marked = markedAnswer(attribution);
    // No provider anywhere in this path, and saying so is the argument: this
    // is the whole of what runs with no key.
    const counts = describeRungs(attribution, false);

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
must('attribute-button').addEventListener('click', doAttribute);
must('search-button').addEventListener('click', doSearch);
query.addEventListener('keydown', (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === 'Enter') doSearch();
});
