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
} from './bancada.js';

/** @typedef {import('../../dist/index.js').Index} Index */

const SNIPPET_WIDTH = 240;

/** @type {Index | null} */
let index = null;

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

function doIndex() {
    const text = source.value.trim();
    if (text === '') {
        say('Paste something first.');
        return;
    }
    const doc = documentFromPastedText(text, 'pasted');
    index = buildLexicalIndex([doc]);
    results.replaceChildren();
    say('Indexed. Search below.');
    showArm();
}

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
