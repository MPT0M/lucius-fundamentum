/**
 * The corpus as the harness modules receive it: one type, two scopes.
 *
 * `run.ts` builds the ROUND map once, for the whole corpus, with the protected
 * regions of every document already computed — masking is per document and
 * costly, so it happens once, not once per response. What `locateSnippet` and
 * the origin resolver receive is the VIEW for one fixture: the same type,
 * restricted to the documents that fixture was generated from. The scope is
 * not cosmetic: a snippet repeated in an unrelated law is ambiguous against the
 * round and unique against the view, and a citation pointing at a document
 * outside the fixture is exactly the failure the harness exists to notice.
 */

import type { ProtectedSpan } from '../../src/mask.js';

export interface MaskedDocument {
    /** Raw text. The only field `locateSnippet` reads — masked text is never matched against. */
    readonly text: string;
    /** `maskProtectedRegions(text).spans`, ready-made: the scorer reads them, the locator ignores them. */
    readonly regions: readonly ProtectedSpan[];
}

/** Keyed by the manifest's `documentId`. */
export type MaskedCorpus = ReadonlyMap<string, MaskedDocument>;
