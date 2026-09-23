/**
 * The markdown of a grounded answer, taken out before the library sees it and
 * kept as data about the text that is left.
 *
 * The library measures everything in code points of the text it is handed,
 * and a `**` it never sees is a `**` that cannot move a coordinate. So the
 * bench strips the syntax FIRST, grounds the clean text, and draws the styling
 * back on top from what this module returns. There is one coordinate system,
 * and it is the clean text's.
 *
 * `renderableFrom` returns three lists, all positioned on the clean text:
 * `blocks` (a line that was a heading, a list item or a quote, with its
 * `line` number in the whole text), `marks` (a
 * strong or emphasised stretch) and `removals` (every piece of syntax that was
 * taken out, as a point with the text it held). `restoreRemovals` puts the
 * removals back, and the two are inverse: restoring the removals of a text
 * into its clean text returns the raw text, code point for code point.
 *
 * **A block is found by its `line`, not moved.** No removal holds a newline —
 * they are line prefixes, emphasis delimiters and escape backslashes, and
 * emphasis does not cross a line — and no citation marker holds one either. So
 * the k-th line is the k-th line in the raw text, in the clean text and in the
 * marked text alike, and a block never needs carrying through the markers.
 * Carrying it would put a marker written at the very end of a heading OUTSIDE
 * the heading, because a stretch's end does not count an insertion there.
 *
 * **What is recognised, and nothing more.** `#` to `######`, `-`, `*`, `+`
 * and `>` at the start of a line when a space follows; `**x**`, `__x__` and
 * `***x***` as strong, `*x*` and `***x***` as emphasis; a backslash before a
 * character that would otherwise be syntax.
 *
 * **What is left in the text on purpose.** Code — inline and fenced — and
 * formulas keep their delimiters, because the delimiters are what the
 * library's mask reads to protect them; taking the backticks out would expose
 * `obj.method()` to the segmenter, which cuts a sentence at its period. Nothing
 * inside a protected region is touched, and where those regions are is asked
 * of `maskProtectedRegions` itself rather than re-derived here: a second copy
 * of the rule is a second place for it to change, and the day the two
 * disagreed the parser would style what the mask protects. An unpaired fence
 * therefore opens no region here either, because it opens none there.
 * `_x_` is not emphasis — `snake_case` is common in a technical answer — and
 * links, tables, images and ordered-list numerals stay as written.
 *
 * **Limits, stated rather than discovered.** Emphasis does not cross a line.
 * A delimiter run pairs only with a run of the same length, so `***a** b*`
 * stays literal. A line takes at most one block prefix: `> - x` is a quote
 * whose text begins with `- `.
 */

import { maskProtectedRegions } from '../../dist/index.js';

/**
 * @typedef {'heading' | 'item' | 'quote'} BlockKind
 * @typedef {{ start: number, end: number, line: number, kind: BlockKind, level?: number }} Block
 * @typedef {{ start: number, end: number, kind: 'strong' | 'em' }} Mark
 * @typedef {{ start: number, end: number, attach: 'left' | 'right', text: string }} Removal
 * @typedef {{ text: string, blocks: Block[], marks: Mark[], removals: Removal[] }} Renderable
 */

/** Characters a backslash can make literal. Anything else keeps its backslash. */
const ESCAPABLE = new Set(['\\', '*', '_', '#', '-', '+', '>', '`']);

/** The kinds of region whose inside is never read as markdown. */
const PROTECTED_KINDS = new Set(['code', 'formula', 'url']);

/**
 * @param {string} raw the text as the person wrote it
 * @returns {Renderable}
 */
export function renderableFrom(raw) {
    const points = Array.from(raw);
    const guarded = protectedPoints(raw, points.length);

    /** Raw index → the syntax taken out there, and which side of a marker it keeps. */
    /** @type {Map<number, { length: number, attach: 'left' | 'right' }>} */
    const cuts = new Map();
    /** @type {{ rawStart: number, rawEnd: number, line: number, kind: BlockKind, level?: number }[]} */
    const rawBlocks = [];
    /** @type {{ rawStart: number, rawEnd: number, kind: 'strong' | 'em' }[]} */
    const rawMarks = [];

    let lineStart = 0;
    let line = 0;
    while (lineStart <= points.length) {
        let lineEnd = lineStart;
        while (lineEnd < points.length && points[lineEnd] !== '\n') lineEnd++;
        const contentStart = readPrefix(points, guarded, lineStart, lineEnd, line, cuts, rawBlocks);
        readInline(points, guarded, contentStart, lineEnd, cuts, rawMarks);
        lineStart = lineEnd + 1;
        line++;
    }

    return emit(points, cuts, rawBlocks, rawMarks);
}

/**
 * Puts the removals back into a text, in order, and returns the result.
 *
 * A single pass with a cursor, the same shape as the library's own
 * `writeMarkers`: sort by position, then walk forward concatenating the text
 * and the removed syntax. The sort is stable, so removals at one position come
 * back in the order they were listed — which is the order they had in the raw
 * text. Splicing each one in at its index instead would put the second of two
 * coincident removals BEFORE the first, and `## **Título**` would come back as
 * `**## Título**`.
 *
 * @param {string} text the text the removals are positioned on
 * @param {readonly { start: number, text: string }[]} removals
 * @returns {string}
 */
export function restoreRemovals(text, removals) {
    if (removals.length === 0) return text;
    const points = Array.from(text);
    const ordered = [...removals].sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const removal of ordered) {
        out += points.slice(cursor, removal.start).join('') + removal.text;
        cursor = removal.start;
    }
    return out + points.slice(cursor).join('');
}

/**
 * Which raw code points sit inside code, a formula or a URL.
 *
 * @param {string} raw
 * @param {number} length
 * @returns {boolean[]}
 */
function protectedPoints(raw, length) {
    const guarded = new Array(length).fill(false);
    for (const region of maskProtectedRegions(raw).spans) {
        if (!PROTECTED_KINDS.has(region.kind)) continue;
        for (let i = region.start; i < region.end; i++) guarded[i] = true;
    }
    return guarded;
}

/**
 * Reads one block prefix at the start of a line, and returns where the line's
 * content begins.
 *
 * @param {string[]} points
 * @param {boolean[]} guarded
 * @param {number} lineStart
 * @param {number} lineEnd
 * @param {number} line the line's number in the whole text, counting blank lines
 * @param {Map<number, { length: number, attach: 'left' | 'right' }>} cuts
 * @param {{ rawStart: number, rawEnd: number, line: number, kind: BlockKind, level?: number }[]} rawBlocks
 * @returns {number}
 */
function readPrefix(points, guarded, lineStart, lineEnd, line, cuts, rawBlocks) {
    // A prefix inside a fenced block is code: `# install` in a shell snippet
    // is a comment, not a heading.
    if (lineStart >= lineEnd || guarded[lineStart]) return lineStart;

    let hashes = 0;
    while (lineStart + hashes < lineEnd && points[lineStart + hashes] === '#') hashes++;
    if (hashes >= 1 && hashes <= 6 && points[lineStart + hashes] === ' ') {
        return takePrefix(lineStart, hashes + 1, lineEnd, line, 'heading', hashes, cuts, rawBlocks);
    }

    const first = points[lineStart];
    if ((first === '-' || first === '*' || first === '+') && points[lineStart + 1] === ' ') {
        return takePrefix(lineStart, 2, lineEnd, line, 'item', undefined, cuts, rawBlocks);
    }
    if (first === '>' && points[lineStart + 1] === ' ') {
        return takePrefix(lineStart, 2, lineEnd, line, 'quote', undefined, cuts, rawBlocks);
    }
    return lineStart;
}

/**
 * @param {number} lineStart
 * @param {number} length
 * @param {number} lineEnd
 * @param {number} line
 * @param {BlockKind} kind
 * @param {number | undefined} level
 * @param {Map<number, { length: number, attach: 'left' | 'right' }>} cuts
 * @param {{ rawStart: number, rawEnd: number, line: number, kind: BlockKind, level?: number }[]} rawBlocks
 * @returns {number}
 */
function takePrefix(lineStart, length, lineEnd, line, kind, level, cuts, rawBlocks) {
    // `right`: the prefix opens the line, so a marker landing on its point
    // stays before it, outside the block it introduces.
    cuts.set(lineStart, { length, attach: 'right' });
    rawBlocks.push(level === undefined
        ? { rawStart: lineStart + length, rawEnd: lineEnd, line, kind }
        : { rawStart: lineStart + length, rawEnd: lineEnd, line, kind, level });
    return lineStart + length;
}

/**
 * Pairs the emphasis delimiters of one line and records escapes.
 *
 * A run opens when the code point after it is not whitespace and closes when
 * the one before it is not; a closing run pairs with the nearest open run of
 * the same character and the same length. A run left unpaired stays in the
 * text as written.
 *
 * @param {string[]} points
 * @param {boolean[]} guarded
 * @param {number} from
 * @param {number} to
 * @param {Map<number, { length: number, attach: 'left' | 'right' }>} cuts
 * @param {{ rawStart: number, rawEnd: number, kind: 'strong' | 'em' }[]} rawMarks
 */
function readInline(points, guarded, from, to, cuts, rawMarks) {
    /** @type {{ at: number, length: number, char: string }[]} */
    const open = [];
    let i = from;
    while (i < to) {
        const char = points[i];
        if (guarded[i]) {
            i++;
            continue;
        }
        if (char === '\\' && i + 1 < to && ESCAPABLE.has(points[i + 1] ?? '') && !guarded[i + 1]) {
            // `right`: the backslash belongs to the character after it.
            cuts.set(i, { length: 1, attach: 'right' });
            i += 2;
            continue;
        }
        if (char !== '*' && char !== '_') {
            i++;
            continue;
        }

        let length = 1;
        while (i + length < to && points[i + length] === char && !guarded[i + length]) length++;
        const before = i > from ? points[i - 1] : undefined;
        const after = i + length < to ? points[i + length] : undefined;
        const usable = char === '*' ? length <= 3 : length === 2;
        const wordy = (/** @type {string | undefined} */ p) => p !== undefined && /[\p{L}\p{N}]/u.test(p);
        const canOpen = usable && after !== undefined && !/\s/u.test(after) && (char === '*' || !wordy(before));
        const canClose = usable && before !== undefined && !/\s/u.test(before) && (char === '*' || !wordy(after));

        const partner = canClose ? findOpen(open, char, length) : -1;
        if (partner >= 0) {
            const opener = open[partner];
            open.length = partner;
            if (opener !== undefined) {
                // `right` on the opener: a marker at its point stays outside
                // the emphasis it opens. `left` on the closer: a marker at its
                // point comes after it, outside the emphasis it closes.
                cuts.set(opener.at, { length, attach: 'right' });
                cuts.set(i, { length, attach: 'left' });
                // Never zero-width, and the screen depends on it: a mark goes
                // through `carry`, which refuses a point without `attach`. An
                // opener and a closer cannot touch, because the run scanner
                // fuses adjacent equal characters into one run.
                const inner = { rawStart: opener.at + length, rawEnd: i };
                if (length >= 2) rawMarks.push({ ...inner, kind: 'strong' });
                if (length !== 2) rawMarks.push({ ...inner, kind: 'em' });
            }
        } else if (canOpen) {
            open.push({ at: i, length, char });
        }
        i += length;
    }
}

/**
 * @param {{ at: number, length: number, char: string }[]} open
 * @param {string} char
 * @param {number} length
 * @returns {number}
 */
function findOpen(open, char, length) {
    for (let k = open.length - 1; k >= 0; k--) {
        const run = open[k];
        if (run !== undefined && run.char === char && run.length === length) return k;
    }
    return -1;
}

/**
 * Builds the clean text and moves every raw position onto it.
 *
 * @param {string[]} points
 * @param {Map<number, { length: number, attach: 'left' | 'right' }>} cuts
 * @param {{ rawStart: number, rawEnd: number, line: number, kind: BlockKind, level?: number }[]} rawBlocks
 * @param {{ rawStart: number, rawEnd: number, kind: 'strong' | 'em' }[]} rawMarks
 * @returns {Renderable}
 */
function emit(points, cuts, rawBlocks, rawMarks) {
    /** raw index → clean index, for every raw position including the end. */
    const cleanAt = new Array(points.length + 1);
    /** @type {string[]} */
    const kept = [];
    /** @type {Removal[]} */
    const removals = [];
    let i = 0;
    while (i < points.length) {
        cleanAt[i] = kept.length;
        const cut = cuts.get(i);
        if (cut !== undefined) {
            removals.push({
                start: kept.length,
                end: kept.length,
                attach: cut.attach,
                text: points.slice(i, i + cut.length).join(''),
            });
            for (let k = 1; k < cut.length; k++) cleanAt[i + k] = kept.length;
            i += cut.length;
            continue;
        }
        kept.push(points[i] ?? '');
        i++;
    }
    cleanAt[points.length] = kept.length;

    const at = (/** @type {number} */ raw) => /** @type {number} */ (cleanAt[raw]);
    return {
        text: kept.join(''),
        blocks: rawBlocks.map(({ rawStart, rawEnd, ...rest }) => ({ start: at(rawStart), end: at(rawEnd), ...rest })),
        marks: rawMarks
            .map(({ rawStart, rawEnd, kind }) => ({ start: at(rawStart), end: at(rawEnd), kind }))
            .sort((a, b) => a.start - b.start),
        removals,
    };
}
