/**
 * The three registers the screen reads, and the boundary made concrete.
 *
 * `SourceDoc` is `{ id, text, pageNumber?, page? }` and nothing else. A name,
 * a page count, a category and a label are not in it, deliberately: a library
 * that cannot learn a document's name can never put a wrong one in a citation.
 * So they live here, in the caller's own register, keyed by the id the library
 * hands back on a hit.
 *
 * The prototype filled these by hand, as fixtures. The bench fills them from
 * what the package answered, and the shapes are unchanged — that they could
 * stay unchanged is the part worth noticing.
 */

/**
 * **`url` and a `cat` of `'Web'` describe a source this bench cannot make.**
 * The screen was drawn for a library that also holds web pages: it has a globe
 * icon, an "Open in browser" button and a tile that reads `—` instead of a page
 * count. Nothing produces either field — the only writer sets `cat:
 * 'Documents'` every time — so those nine readers are drawn for an entrance
 * that does not exist. They are kept rather than deleted because whether this
 * bench should ever index a URL is a question about the example, not a defect
 * in it; this note is here so the next reader does not spend an afternoon
 * looking for the code that fills them.
 *
 * @typedef {object} DocEntry
 * @property {string} name what a reader calls it
 * @property {string} ext uppercase, for the tile
 * @property {string} cat the group the tile sits under; always `'Documents'` here
 * @property {number} [pages] highest page seen, when it has pages
 * @property {string} [url] never set by this bench — see above
 */

/**
 * `heading` has the same shape of absence as `url`: the screen reads it in five
 * places as the position of a hit inside a document that has no pages, and this
 * bench has nothing that produces one. Declared so the field a reader meets in
 * `proto-logic.js` is not missing from the type it belongs to.
 *
 * @typedef {object} SourceEntry
 * @property {number} n the marker a reader sees
 * @property {string} doc key into `DOCS`
 * @property {number} [page] where the viewer opens; see `viewerCoordinate`
 * @property {string} [heading] never set by this bench — see above
 * @property {string} label
 */

/** @typedef {string | { hl: string }} PageLine */

/** @type {Record<string, DocEntry>} */
export const DOCS = {};

/** @type {SourceEntry[]} */
export const SOURCES = [];

/**
 * `fileName:page` to the lines the viewer paints.
 *
 * The FILE name, not the document id the library answers with: one PDF is many
 * documents to the library — `lei.pdf#p7` is its own `SourceDoc` — and one tile
 * to a reader. So a hit on `lei.pdf#p7` is filed here under `lei.pdf:7`, which
 * is also what the viewer asks for when it opens page 7 of that tile.
 *
 * @type {Record<string, PageLine[]>}
 */
export const PAGE_TEXT = {};
