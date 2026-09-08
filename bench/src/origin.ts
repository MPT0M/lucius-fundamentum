/**
 * What is known about the document a cited chunk came from, once the hints the
 * emitter returned have been matched against the corpus.
 *
 * The resolution itself lives with the module that reads the manifest
 * (`parse.ts`); the scorer only aggregates what it is handed. The type lives
 * here so that both can name it without the scorer depending on the parser.
 */

export interface ResolvedOrigin {
    /** Key of the ROUND map the hint matched, or null when neither hint resolved. */
    readonly documentId: string | null;
    /** Which hint resolved it. Instrumentation for the first real run, not a result. */
    readonly resolvedBy: 'customMetadata' | 'title' | null;
    /**
     * False when the hint resolved to a document that is NOT among the ones
     * this fixture was generated from: the citation points at another document.
     * A third state, distinct from "did not resolve".
     */
    readonly inFixture: boolean;
}
