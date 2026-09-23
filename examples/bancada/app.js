/**
 * The bench: the prototype's screen, fed by the package.
 *
 * The screen is `index.html` and `proto-logic.js` — both the project's own
 * prototype, with its `{{ }}` bindings rewritten as attributes and nothing
 * else moved. This file is the part that did not exist there, because the
 * prototype had fixtures where this has a library: ingest, index, search,
 * ground, and the three registers the screen reads.
 *
 * What is NOT here is any rule worth pinning. Those live in `bancada.js`,
 * which touches neither `document` nor Node, and the suite covers them.
 */

import { mount, createElement } from './dc.js';
import { Component } from './proto-logic.js';
import { DOCS, SOURCES, PAGE_TEXT } from './registers.js';
import {
    describeArm,
    documentFromFile,
    buildLexicalIndex,
    buildDenseIndex,
    attributeWithoutKey,
    attributeWithKey,
    markedAnswer,
    describeRungs,
    highlightParts,
    resultForScreen,
    looksReadable,
    isPdf,
    pageToDocument,
    classifyLoadFailure,
    corpusFrom,
    providerMayBeAsked,
    unsupportedRanges,
    codePointsOf,
    paragraphBoundsOf,
    markersIn,
    fileOfId,
    pageOfId,
    remoteProvider,
    READABLE_TEXT,
} from './bancada.js';
import { readPdf } from './pdf.js';
import { save, load, forget } from './storage.js';
import { loadIndex } from '../../dist/index.js';

/** @typedef {import('../../dist/index.js').Index} Index */
/** @typedef {import('../../dist/index.js').PageImage} PageImage */
/** @typedef {import('../../dist/index.js').SearchResult} SearchResult */
/** @typedef {import('../../dist/index.js').SourceDoc} SourceDoc */

/** @type {Index | null} */
let index = null;
/** @type {import('../../dist/index.js').EmbeddingProvider | null} */
let provider = null;
/** @type {SourceDoc[]} */
const dropped = [];
/** @type {Map<string, PageImage>} */
const pageImages = new Map();
/** @type {Map<string, string>} */
const docTexts = new Map();

const SNIPPET_WIDTH = 220;

/**
 * The last grounding, kept so the screen can redraw it.
 *
 * Two settings change how an answer is drawn without changing the answer:
 * marker density re-attributes `lastGrounded`, and the unsupported-text
 * underline redraws `lastAttribution` without paying for the attribution a
 * second time. **Both are cleared when the document they rest on leaves**, or
 * the next click puts a citation back on screen for a file the bench no longer
 * has.
 *
 * @type {string | null}
 */
let lastGrounded = null;

/** @type {import('../../dist/index.js').Attribution | null} */
let lastAttribution = null;

// `false` until the probe below answers: the switch and its note are the only
// place the screen mentions a provider, and showing them before anything is
// known offers a choice that may not exist.
const component = new Component({ semanticAvailable: false });

// The dashed underline on unsupported stretches starts OFF, which is the
// bench's decision and not the prototype's. `proto-logic.js` ships `mark: true`
// and stays untouched: that file declares itself a port with three changed
// lines, and a fourth would make the claim false for a default this file can
// set. The control that flips it is on screen either way, under "Unsupported
// text" — what changes is which side the screen opens on. An answer whose every
// clause is cited reads, with the underline on, as one long dashed rule with
// nothing to say.
component.setState({ mark: false });

/** The one question the three network-bound paths ask, in the screen's terms. */
const meaningIsLive = () =>
    index !== null && providerMayBeAsked(component.state.semantic === true, provider !== null, index.denseArm);

/**
 * The handle of the message currently on screen, so the next one can cancel it.
 *
 * Without this each `say` armed a timer that cleared the balloon 2.6 seconds
 * later no matter who had written in it since. Two messages in the same tick
 * and the first one's timer wiped the second; a message during a real network
 * call and the balloon went out while the provider was still answering.
 *
 * @type {number | null}
 */
let saying = null;

/**
 * One sentence in the prototype's own wait balloon, for 2.6 seconds.
 *
 * The label is cleared with the balloon, not left behind: the screen falls
 * back to 'Comparing meaning' while nothing more specific is being said, and
 * a stale sentence would caption every later wait with an old event.
 *
 * @param {string} message
 */
function say(message) {
    if (saying !== null) window.clearTimeout(saying);
    component.setState({ waiting: true, waitLabel: message });
    saying = window.setTimeout(() => {
        saying = null;
        component.setState({ waiting: false, waitLabel: null });
    }, 2600);
}

/**
 * Keeps the balloon lit while something slow is really happening.
 *
 * A message is a message and a network call is a network call: the timer above
 * exists to make a sentence disappear, and it must not be allowed to end a
 * wait that nothing has finished. Anything that lights the balloon for the
 * duration of a call cancels the pending message first.
 */
function holdTheBalloon() {
    if (saying !== null) window.clearTimeout(saying);
    saying = null;
}

/**
 * What a cache write says when it fails.
 *
 * The cache is the only place the bench keeps anything across a reload, and it
 * fails for ordinary reasons: a private window, blocked site data, a quota
 * filled by the page images of a long PDF. Written as fire-and-forget with no
 * catch, the rejection went to the console and the person found out on the
 * next visit, when the corpus they thought was saved was not there.
 *
 * @param {unknown} error
 */
function sayFailure(error) {
    say('Not cached: ' + (error instanceof Error ? error.message : String(error)));
}

/**
 * The library register, rebuilt from what the bench holds.
 *
 * This is the boundary made concrete: `SourceDoc` is `{ id, text, pageNumber?,
 * page? }` and nothing else — no name, no page count, no category — so all of
 * that lives here, keyed by the id the library hands back on a hit. The pages
 * of one PDF collapse into one tile, under the file's own name.
 */
function refreshDocs() {
    for (const key of Object.keys(DOCS)) delete DOCS[key];
    for (const doc of dropped) {
        const file = fileOfId(doc.id);
        const ext = (file.split('.').pop() ?? '').toUpperCase();
        // `pages` is left OUT for a document that has none, not set to zero.
        // The prototype shows the counter whenever the field exists, so a zero
        // printed "1 / 0" under every text file — a page count for a thing
        // with no pages, which reads as a bug in the library rather than in
        // the register that invented the field.
        const entry = DOCS[file] ?? { name: file, ext, cat: 'Documents' };
        if (doc.pageNumber !== undefined) entry.pages = Math.max(entry.pages ?? 0, doc.pageNumber);
        DOCS[file] = entry;
    }
    component.setState({ docKeys: Object.keys(DOCS) });
}

/**
 * Taking one file out of the bench, everywhere it is held.
 *
 * The tile's own handler filtered `docKeys` and stopped there, so the document
 * left the shelf and stayed in the corpus, in the index and in the cache: a
 * search still answered out of it, the viewer still opened it, and the next
 * reindex put the tile back. On a bench whose subject is a library that keeps
 * your documents on your machine, a remove button that removes nothing is the
 * worst thing on the screen.
 *
 * @param {string} file the name a tile carries, which is `fileOfId` of its pages
 */
function dropDoc(file) {
    for (let i = dropped.length - 1; i >= 0; i -= 1) {
        const doc = dropped[i];
        if (doc === undefined || fileOfId(doc.id) !== file) continue;
        docTexts.delete(doc.id);
        pageImages.delete(doc.id);
        dropped.splice(i, 1);
    }
    // What was on screen was computed over a corpus that no longer contains
    // this file: the results list and the grounded answer cite it, and both
    // read the register by name. `sourceRows` did exactly that and threw on
    // the missing entry, which took the whole render down — one removed tile
    // and the page went blank. The answer leaves with the document rather
    // than staying on screen citing it.
    SOURCES.length = 0;
    for (const key of Object.keys(PAGE_TEXT)) delete PAGE_TEXT[key];
    // The two the screen can redraw FROM have to go as well, or the answer
    // comes back: `redrawBody` rebuilds the body out of `lastAttribution` on
    // the next click of "Marked"/"Plain", and `regroundForMode` re-attributes
    // `lastGrounded` on the next change of marker density. Either one would
    // put a citation to this file back on a screen that no longer has it, and
    // with `SOURCES` empty its markers open nothing.
    lastAttribution = null;
    lastGrounded = null;
    const wasOpen = component.state.docKey === file;
    component.setState({ results: null, groundedBody: null, ...(wasOpen ? { docKey: null, where: null } : {}) });

    refreshDocs();
    if (dropped.length > 0) {
        doIndex();
        return;
    }
    // An empty shelf means no index, not an index of nothing: `doIndex`
    // returns early on an empty corpus, which would leave the previous index
    // answering questions about the file that was just removed.
    index = null;
    void forget().catch(sayFailure);
    say('Nothing indexed.');
}

// —————————————————————————————————————————————————————————————————
// Ingest
// —————————————————————————————————————————————————————————————————

/** @param {File} file */
async function takePdf(file) {
    say('Reading ' + file.name);
    for (const page of await readPdf(await file.arrayBuffer())) {
        const doc = pageToDocument(file.name, page);
        if (doc === null) continue;
        // Kept for every page that becomes a document, including the ones
        // indexed as text: the viewer has to show any hit's page, not only
        // the pages the library received an image for.
        pageImages.set(doc.id, page.image);
        dropped.push(doc);
    }
}

/**
 * Both shapes, because both arrive. The drop target hands a `FileList`;
 * the shelf's picker hands an array, because it copies the selection before
 * clearing the field. **Nothing here would catch the annotation being wrong**
 * — the only caller reaches this through the component, which is `@ts-nocheck`
 * — so it is written to match what the function actually accepts.
 *
 * @param {readonly File[] | FileList | null} files
 */
async function take(files) {
    const list = [...(files ?? [])];
    const refused = list.filter((f) => !looksReadable(f.name) && !isPdf(f.name));

    for (const file of list) {
        // `File.text()` decodes as UTF-8, which is the bench's assumption: a
        // file saved in a legacy encoding arrives mangled here, not inside
        // the library.
        if (looksReadable(file.name)) dropped.push(documentFromFile(file.name, await file.text()));
        else if (isPdf(file.name)) await takePdf(file);
    }
    refreshDocs();
    doIndex();

    // Naming what was refused rather than skipping it quietly: a file that
    // vanishes on drop reads as a broken page.
    if (refused.length > 0) {
        say('Ignored ' + refused.map((f) => f.name).join(', ') + ' — reads ' + READABLE_TEXT.join(', ') + ' and .pdf');
    }
}

// —————————————————————————————————————————————————————————————————
// Index, embed, cache
// —————————————————————————————————————————————————————————————————

function doIndex() {
    const docs = corpusFrom(dropped, docTexts);
    if (docs.length === 0) return;
    for (const doc of docs) docTexts.set(doc.id, doc.text);
    index = buildLexicalIndex(docs);
    say('Indexed ' + docs.length + ' — ' + describeArm(index.denseArm).headline);
    void save(index.serialize(), pageImages, docTexts).catch(sayFailure);
    component.forceUpdate();
}

async function doEmbed() {
    if (provider === null) return;
    if (index === null) {
        // Turning the switch on with an empty bench used to return in silence,
        // leaving it lit over a note that says excerpts reach the provider.
        component.setState({ semantic: false });
        say('Nothing indexed yet — add a source first.');
        return;
    }
    // `absent` is the only arm worth paying for, and `describeArm` is where
    // that distinction is already written down. A `ready` arm has its vectors
    // and a `needs-provider` one carries them in the artifact: embedding over
    // either charges for the collection a second time to buy what it owns.
    if (!describeArm(index.denseArm).offersEmbedding) {
        say(describeArm(index.denseArm).headline);
        component.forceUpdate();
        return;
    }
    const docs = corpusFrom(dropped, docTexts);
    if (docs.length === 0) {
        // The switch goes back off for the same reason the failure path below
        // turns it off: lit, its note reads "Excerpts go to the provider", and
        // with nothing indexed there is no excerpt and nothing to send. A lit
        // switch over an empty shelf describes something that is not going to
        // happen.
        component.setState({ semantic: false });
        say('Nothing indexed yet — add a source first.');
        return;
    }
    try {
        // No percentage, on purpose: `embed-start` and `embed-done` are one
        // emission each and the second is terminal, so the library explains
        // where the time is going rather than measuring it.
        index = await buildDenseIndex(docs, provider, (event) => {
            if (event.kind === 'embed-start') say('Embedding ' + event.total + ' chunk(s)');
            if (event.kind === 'embed-done') say('Embedded ' + event.embedded + ' of ' + event.total);
        });
    } catch (error) {
        // The switch goes back off rather than staying lit over an arm that
        // never came up. Its own note claims excerpts reach the provider, and
        // a provider that just refused makes that sentence a false one left on
        // the screen — while `meaningIsLive` would keep every later question
        // local anyway, so the lit switch would describe nothing.
        component.setState({ semantic: false });
        say(error instanceof Error ? error.message : String(error));
        return;
    }
    void save(index.serialize(), pageImages, docTexts).catch(sayFailure);
    component.forceUpdate();
}

async function restore() {
    const cached = await load();
    if (cached === null) return;
    try {
        // The provider goes in, and the probe runs before this for that
        // reason. Without it a cached artifact that CARRIES its vectors comes
        // back `needs-provider` — the library's way of saying the numbers are
        // here and the key is not — and the bench, holding the key, would sit
        // on that state and re-embed the whole corpus to buy what it owns.
        index = loadIndex(cached.artifact, provider === null ? {} : { provider });
        for (const [id, image] of cached.pages) pageImages.set(id, image);
        for (const [id, text] of cached.texts) {
            docTexts.set(id, text);
            // The page number is read back out of the id rather than stored
            // beside it: `pageToDocument` writes `file.pdf#p7` and `fileOf`
            // already splits on it, so a second copy of the same fact could
            // disagree with the id the library answers with.
            const pageNumber = pageOfId(id);
            // **The image comes back too, or the page silently leaves the
            // index.** A page indexed as an image is `{ text: '', page }`;
            // restored without its `page` it is a document with empty text and
            // nothing else, which produces no chunk at all — so the next
            // reindex drops it and saves that over the good artifact. The text
            // stays empty on that branch because a `SourceDoc` carrying both
            // an image and text is refused by the library, on purpose.
            const image = pageImages.get(id);
            if (pageNumber === undefined) dropped.push({ id, text });
            else if (text === '' && image !== undefined) dropped.push({ id, text: '', pageNumber, page: image });
            else dropped.push({ id, text, pageNumber });
        }
        refreshDocs();
    } catch (error) {
        // `discard` is false for exactly the refusals whose vectors are still
        // good and cost money — those ask for the matching provider instead.
        const verdict = classifyLoadFailure(error);
        if (verdict.discard) await forget();
        say(verdict.message);
    }
}

async function askServerForProvider() {
    try {
        const shape = await (await fetch('/provider')).json();
        if (shape.configured === true) provider = remoteProvider(shape);
    } catch {
        // The bench works without one. A failed probe is not worth a banner.
    }
    // The switch appears only once there is something behind it, which is the
    // prototype's own rule: no key configured, no padlock on the screen.
    component.props['semanticAvailable'] = provider !== null;
    component.forceUpdate();
}

// —————————————————————————————————————————————————————————————————
// What fills SOURCES and PAGE_TEXT
// —————————————————————————————————————————————————————————————————

/**
 * Where the viewer opens a hit, which is not what the citation calls it.
 *
 * A document with no pages still needs somewhere to open — it is one piece,
 * and the piece lives at 1. Three places have to agree on that number or the
 * viewer looks up a page nobody wrote: the key this register is filed under,
 * the source row, and the result line. What a READER is shown is decided
 * elsewhere, by whether the register says the document has pages at all, so
 * that this coordinate never reaches the screen as "p. 1" on a text file.
 *
 * @param {SearchResult} hit
 * @returns {number}
 */
function viewerCoordinate(hit) {
    return hit.chunk.pageNumber ?? 1;
}

/**
 * The page register the viewer reads.
 *
 * The shape is the prototype's: a list of paragraphs where `{ hl }` marks the
 * stretch to light. It is built from the text the library RECEIVED — a second
 * extraction would move every offset after the first difference, and the
 * highlight would land on the wrong words while still looking certain.
 *
 * @param {SearchResult} hit
 */
function rememberPage(hit) {
    const key = fileOfId(hit.chunk.documentId) + ':' + viewerCoordinate(hit);
    const text = docTexts.get(hit.chunk.documentId);
    if (text === undefined || hit.chunk.text === '') {
        // A page indexed as an image has no span narrower than itself, and
        // inventing a highlight would invent a precision the index lacks.
        PAGE_TEXT[key] = ['Indexed as an image: the page is the unit, so nothing narrower is lit.'];
        return;
    }
    PAGE_TEXT[key] = highlightParts(text, hit.chunk.span).map((piece) =>
        piece.highlighted ? { hl: piece.text } : piece.text,
    );
}

/** @param {readonly SearchResult[]} hits */
function rememberSources(hits) {
    SOURCES.length = 0;
    hits.forEach((hit, i) => {
        rememberPage(hit);
        const file = fileOfId(hit.chunk.documentId);
        SOURCES.push({
            n: i + 1,
            doc: file,
            page: viewerCoordinate(hit),
            label: hit.chunk.pageNumber === undefined ? file : file + ' — p. ' + hit.chunk.pageNumber,
        });
    });
}

/** @param {string} asked */
async function runSearch(asked) {
    if (index === null || asked.trim() === '') return;
    // `search` fuses both arms and refuses while the dense one is not ready;
    // `searchLexical` is the honest call when it is not.
    const hits = meaningIsLive() ? await index.search(asked) : index.searchLexical(asked);
    rememberSources(hits);
    // The prototype's shape, kept: `doc` keys into the register, `where` is a
    // page, `snippet` is the line a reader sees. Sending it `{ n, chunk }`
    // instead was my own invention, and it left the panel reading zero with
    // nothing to say why.
    component.setState({
        results: hits.map((hit) => ({
            doc: fileOfId(hit.chunk.documentId),
            where: viewerCoordinate(hit),
            snippet: resultForScreen(hit, SNIPPET_WIDTH).snippet,
        })),
    });
}

/**
 * The composer's text with its attachment read into it.
 *
 * Only the formats the bench can decode as text: a PDF clipped here would
 * arrive as binary through `File.text()` and be grounded as if it were prose —
 * a screen full of characters nobody wrote, with markers on them. Refusing by
 * name and saying so is the same rule the drop target already follows.
 *
 * @param {string} typed
 * @param {File | null} attached
 * @returns {Promise<string | null>} null when the attachment was refused
 */
async function withAttachment(typed, attached) {
    if (attached === null) return typed;
    if (!looksReadable(attached.name)) {
        say('Grounds text: ' + READABLE_TEXT.join(', ') + ' — drop a .pdf on the page to index it instead');
        return null;
    }
    const contents = await attached.text();
    return typed.trim() === '' ? contents : typed + '\n\n' + contents;
}

/**
 * The library's own name for what the screen's two-way switch asks.
 *
 * The switch was decoration: it changed the caption under it — "One marker per
 * block" — and left the markers one per sentence, because the bench never
 * passed the option the library publishes. The caption was the part that
 * stated the claim, so it was the part that was wrong.
 *
 * @returns {import('../../dist/index.js').AttributionGranularity}
 */
function askedGranularity() {
    return component.state.mode === 'paragraph' ? 'paragraph' : 'cluster';
}

/**
 * @param {string} text what was typed into the composer
 * @param {File | null} [attached] what was clipped to it, if anything
 */
async function runGround(text, attached) {
    if (index === null) return;
    // The attachment IS the text to ground — the composer's own footer says
    // "Ready to ground" the moment one is clipped on. Both are kept when both
    // are there: dropping either would discard something the person supplied,
    // and a blank line is what the attributor reads as a paragraph break
    // anyway.
    const whole = await withAttachment(text, attached ?? null);
    if (whole === null || whole.trim() === '') return;
    text = whole;
    lastGrounded = text;
    const usesProvider = meaningIsLive();
    const granularity = askedGranularity();
    const candidates = usesProvider ? await index.search(text) : index.searchLexical(text);
    const attribution = usesProvider
        ? await attributeWithKey(
              text,
              candidates,
              /** @type {NonNullable<typeof provider>} */ (provider),
              {
                  onWorking: () => {
                      // A pending message must not put this out.
                      holdTheBalloon();
                      component.setState({ waiting: true, waitLabel: 'Asking the provider' });
                  },
                  // Says nothing about the outcome: the rejection path runs
                  // this too, and a success sentence hung here announces one
                  // that did not happen.
                  onSettled: () => component.setState({ waiting: false, waitLabel: null }),
              },
              granularity,
          )
        : attributeWithoutKey(text, candidates, granularity);

    lastAttribution = attribution;
    rememberSources(attribution.sources);
    component.setState({
        groundedBody: bodyFor(attribution),
        rungs: describeRungs(attribution, usesProvider),
    });
}

/**
 * Redoing the last grounding at the density the switch now asks for.
 *
 * The answer on screen was attributed under the old setting, and a screen that
 * changes its caption without changing its markers describes something nobody
 * ran. With nothing grounded yet there is nothing to redo, and the switch is
 * simply the setting the next grounding will use.
 */
function regroundForMode() {
    if (lastGrounded === null) return;
    void runGround(lastGrounded).catch((error) => say(error instanceof Error ? error.message : String(error)));
}

/**
 * The grounded answer as the prototype drew it: the text, with a marker on
 * every stretch a passage supports, and each marker opening that passage.
 *
 * The markers come from the formatter rather than from the spans directly.
 * `formatAttribution` returns its own coordinates — every offset reindexed
 * past the markers it just inserted — and mixing those with the engine's is
 * the drift the formatter returns spans to prevent. So everything here indexes
 * ONE array of code points: the paragraph breaks, the markers and the supported
 * spans are all positions in it, and a position means the same thing to all
 * three.
 *
 * `chip()`, `openDoc()` and `unsupported()` are the prototype's own, so the
 * marker and the dashed underline look and behave as they did there. What
 * changed is that the passage behind them is real.
 *
 * @param {import('../../dist/index.js').Attribution} attribution
 * @returns {Element}
 */
function bodyFor(attribution) {
    const marked = markedAnswer(attribution);
    const screen = /** @type {any} */ (component);
    // CODE POINTS, once, and everything below indexes into this array.
    // `formatAttribution` answers in code points and a JavaScript string
    // indexes in UTF-16 units; they agree until the answer carries one astral
    // character, and from there every offset is early by one per astral
    // character before it. The underline would move off the words it is about
    // and look exactly as sure as a correct one.
    const points = codePointsOf(marked.text);
    // The setting the screen offers under "Unsupported text", which had
    // nothing to act on while the spans were being thrown away.
    const gaps = component.state.mark === true ? unsupportedRanges(points.length, marked.spans) : [];
    const body = createElement('div', null);

    for (const [from, to] of paragraphBoundsOf(points)) {
        const p = createElement('p', { style: { margin: '0 0 1.15rem' } });
        let at = from;
        for (const found of markersIn(points, from, to)) {
            appendText(p, points, at, found.start, gaps, screen);
            p.append(chipFor(found.marker, screen));
            at = found.end;
        }
        appendText(p, points, at, to, gaps, screen);
        body.append(p);
    }
    return body;
}

/**
 * Appends `points[from, to)`, cut so the stretches resting on nothing carry the
 * dashed underline and the rest is plain text.
 *
 * With marking off the list of gaps is empty and this is one text node, which
 * is what it was before the setting did anything.
 *
 * @param {Element} into
 * @param {readonly string[]} points the answer in code points
 * @param {number} from
 * @param {number} to
 * @param {readonly { start: number, end: number }[]} gaps
 * @param {any} screen the prototype's component, for its own dashed style
 */
function appendText(into, points, from, to, gaps, screen) {
    if (to <= from) return;
    const said = (/** @type {number} */ start, /** @type {number} */ end) => points.slice(start, end).join('');
    let at = from;
    for (const gap of gaps) {
        const start = Math.max(gap.start, from);
        const end = Math.min(gap.end, to);
        if (end <= start) continue;
        if (start > at) into.append(document.createTextNode(said(at, start)));
        into.append(createElement('span', { style: screen.unsupported() }, said(start, end)));
        at = end;
    }
    if (at < to) into.append(document.createTextNode(said(at, to)));
}

/**
 * @param {number} n
 * @param {any} screen
 * @returns {Element}
 */
function chipFor(n, screen) {
    return createElement(
        'button',
        {
            type: 'button',
            // Lit when the viewer is showing the passage this marker rests on.
            // The prototype did this and the port lost it by passing `false`:
            // with several markers in an answer, nothing on the screen said
            // which one the open document belongs to.
            style: screen.chip(n, screen.activeN() === n),
            // `openChip` and not `openDoc`: the prototype puts a card over the
            // marker first — the passage itself, with the document's name and
            // a way into it — and jumping straight to the viewer skipped the
            // one screen that shows WHAT the marker rests on. It measures
            // against `.fd-doc` and `.fd-text`, which are this body's own
            // ancestors in the page.
            onClick: (/** @type {Event} */ event) => screen.openChip(n, event),
        },
        String(n),
    );
}

function redrawBody() {
    if (lastAttribution !== null) component.setState({ groundedBody: bodyFor(lastAttribution) });
}

/**
 * The answer on screen as plain text, markers and all — what the copy button
 * puts on the clipboard.
 *
 * `markedAnswer` rather than the DOM: it is the same string the body was drawn
 * from, so the copy carries the markers the reader is looking at rather than
 * whatever the rendering happened to produce.
 *
 * @returns {string | null} null while nothing has been grounded
 */
function groundedText() {
    return lastAttribution === null ? null : markedAnswer(lastAttribution).text;
}

// —————————————————————————————————————————————————————————————————
// Boot
// —————————————————————————————————————————————————————————————————

const wired = /** @type {any} */ (component);
wired.runSearchText = runSearch;
wired.runGroundText = runGround;
wired.doIndex = doIndex;
wired.doEmbed = doEmbed;
// What turning the switch on means: the screen asks, this embeds. Before this
// the arm had no caller at all — `doEmbed` was defined, hung here, and reached
// by nothing on the screen, so the half of the package the key exists for was
// unreachable from the page that advertises it.
wired.turnOnMeaning = doEmbed;
// The prototype's wait only appears when something really goes to the network.
wired.searchIsDense = meaningIsLive;
// Both refusals on the screen's side come back here rather than writing the
// label themselves, so a refusal is visible for as long as any other message
// and disappears the same way.
wired.report = say;
wired.dropDoc = dropDoc;
// The shelf's own way in. Dropping on the page always worked and nothing on
// screen said so, so this is the path most people will use.
wired.takeFiles = (/** @type {readonly File[] | FileList} */ files) =>
    void take(files).catch((error) => say(error instanceof Error ? error.message : String(error)));
wired.regroundForMode = regroundForMode;
wired.redrawBody = redrawBody;
wired.groundedText = groundedText;

const shell = document.querySelector('.fd-shell');
if (shell === null) throw new Error('the page is missing .fd-shell');
mount(wired, shell);

document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => {
    event.preventDefault();
    const transfer = /** @type {DragEvent} */ (event).dataTransfer;
    void take(transfer === null ? null : transfer.files).catch((error) =>
        say(error instanceof Error ? error.message : String(error)),
    );
});

void askServerForProvider().then(restore);
