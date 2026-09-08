/**
 * The raw recording of one hosted file-search response, as the harness commits
 * it. The shape mirrors the API's nested structure field by field, every field
 * optional the way protobuf emits it — the recorder writes what came back, and
 * the parser is the one place that decides what an absence means.
 *
 * That decision is per field, never uniform. Protobuf drops a field whose value
 * is the default, so for some fields "absent" is the MOST COMMON case, not a
 * failure: a citation that opens the answer has `startIndex` 0 and the field is
 * simply not there. Reading that as "missing" would send the most common
 * citation to the wrong place in silence — the founding defect of the product,
 * reintroduced in the instrument that measures it. See `parse.ts` for the
 * table of what each absence means.
 */

export interface GoogleRawChunk {
    readonly retrievedContext?: {
        /** The chunk's text. Absent means the marker has no source here. */
        readonly text?: string;
        /** The display name the uploader chose. We upload `documentId` as the name. */
        readonly title?: string;
        /**
         * Hypothesis: that the chunk carries the document's custom metadata.
         * The reference names custom metadata as a resolution path, not its
         * shape here. If the first real run shows it absent, the title is the
         * path and `resolvedBy.customMetadata` stays at zero.
         */
        readonly customMetadata?: readonly { readonly key: string; readonly stringValue?: string }[];
    };
}

export interface GoogleRawSupport {
    readonly segment?: {
        /** Absent = 0: protobuf drops the default. */
        readonly partIndex?: number;
        /** Absent = 0: the span that opens the answer, the most common one. */
        readonly startIndex?: number;
        /** Absent is a violation: it would mean the empty interval `[start, 0)`. */
        readonly endIndex?: number;
        /** Absent is a violation: nothing to check the offsets against. */
        readonly text?: string;
    };
    /** Absent = []: a marker with no source at all. */
    readonly groundingChunkIndices?: readonly number[];
    /** Empty on current models and ignored. */
    readonly confidenceScores?: readonly number[];
}

export interface GoogleRawFixture {
    readonly id: string;
    readonly model: string;
    readonly recordedAt: string;
    readonly reportVersion: string;
    readonly storeEmbeddingModel: string;
    readonly storeChunking: { readonly maxTokensPerChunk: number; readonly maxOverlapTokens: number };
    /** The generated answer, one entry per Part, in order. Offsets are relative to a Part. */
    readonly parts: readonly { readonly text: string }[];
    /** Both spellings are typed: the SDK emits camelCase, a raw fetch emits snake_case. Absent in both = 0 = "did not search". */
    readonly usageMetadata: {
        readonly toolUsePromptTokenCount?: number;
        readonly tool_use_prompt_token_count?: number;
    };
    /** Absent or empty while the search ran is the `emptyMetadata` bucket, decided by the aggregator. */
    readonly groundingMetadata?: {
        readonly groundingChunks?: readonly GoogleRawChunk[];
        readonly groundingSupports?: readonly GoogleRawSupport[];
    };
}
