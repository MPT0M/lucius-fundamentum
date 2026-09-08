/**
 * A cited snippet is located in the source documents, or lands in a named
 * bucket.
 *
 * The hosted file-search API returns the TEXT of the chunk it cited, never its
 * position in the document. The harness recovers the position by literal
 * match — the corpus is uploaded as plain text, byte for byte the string the
 * chunker receives, so a literal match is expected to be possible with no
 * normalization involved (both sides come from the same string; see the
 * `not_found` note below for the status of that expectation). Three outcomes, each with
 * its own destination downstream:
 *
 *   - exactly one occurrence across the view → `exact`, and the span becomes the
 *     citation's source position;
 *   - none → `not_found`: the emitter altered the text — whitespace, a broken
 *     line, a truncation, or the same character written precomposed on one
 *     side and decomposed on the other (`ç` vs `c` + combining cedilla; see
 *     `src/unicode.ts`, which exists because they compare different and render
 *     the same). Matching stays literal on raw text on purpose: positions are
 *     never measured against normalized text, and the plan treats the literal
 *     match as a hypothesis with a decision rule, not a measured fact. The
 *     snippet travels along so the excluded item can still be classified;
 *   - two or more → `ambiguous`: repeated text, in one document or across
 *     several; every occurrence is reported, with its document, because the
 *     locator DID find the text and the document is certain.
 *
 * Excluding the last two from the score is the only honest treatment: picking
 * the first occurrence would move the competitor's number by a decision of
 * ours. This module knows nothing about manifests or origins — it reads the
 * documents it is given and reports what it found.
 */

import type { Span } from '../../src/types.js';
import { countCodePoints } from '../../src/unicode.js';
import type { MaskedCorpus } from './corpus.js';

export interface Occurrence {
    readonly documentId: string;
    /** Code points into the document's raw text, `[start, end)`. */
    readonly span: Span;
}

export type LocateResult =
    /** The one place the snippet occurs; `span` is code points, as in `Occurrence`. */
    | ({ readonly kind: 'exact' } & Occurrence)
    | { readonly kind: 'not_found'; readonly snippet: string }
    | {
          readonly kind: 'ambiguous';
          /** Every occurrence, ordered by document id then position; always two or more. */
          readonly occurrences: readonly Occurrence[];
      };

/**
 * Finds every literal occurrence of `snippet` in the documents of `view`.
 *
 * Overlapping occurrences count separately (`aa` occurs twice in `aaa`): each
 * is a place the citation could have meant. Documents are visited in id order
 * — `sort()` without a comparator, i.e. UTF-16 code unit order — so the result
 * does not depend on how the map was built and is identical on every runtime.
 * That is deliberately NOT locale-alphabetical order: `localeCompare` without a
 * fixed locale looks like an improvement and would make two machines disagree,
 * which is the one property this ordering exists to guarantee. An empty snippet
 * is `not_found` without a scan — there is nothing to locate.
 */
export function locateSnippet(view: MaskedCorpus, snippet: string): LocateResult {
    if (snippet.length === 0) return { kind: 'not_found', snippet };

    const occurrences: Occurrence[] = [];
    for (const documentId of [...view.keys()].sort()) {
        const text = view.get(documentId)!.text;
        let at = text.indexOf(snippet);
        while (at !== -1) {
            const start = countCodePoints(text.slice(0, at));
            occurrences.push({ documentId, span: { start, end: start + countCodePoints(snippet) } });
            at = text.indexOf(snippet, at + 1);
        }
    }

    if (occurrences.length === 0) return { kind: 'not_found', snippet };
    if (occurrences.length === 1) {
        const only = occurrences[0]!;
        return { kind: 'exact', documentId: only.documentId, span: only.span };
    }
    return { kind: 'ambiguous', occurrences };
}
