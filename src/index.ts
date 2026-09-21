/**
 * @nihilo-dev/fundamentum — public surface.
 *
 * Everything the package exports passes through this file. Nothing else under
 * src/ is a public path.
 */

export type { Span } from './types.js';
export { countCodePoints, normalizeUnicode, sliceByCodePoints } from './unicode.js';
export { maskFormulas, MASK_CHAR } from './math.js';
export type { MaskResult } from './math.js';
export { maskProtectedRegions } from './mask.js';
export type { MaskOptions, ProtectedSpan, ProtectedRegionKind, ClassifiedMaskResult } from './mask.js';
export { maskAbbreviationPeriods, PT_BR_ABBREVIATIONS } from './abbreviations.js';
export type { AbbreviationList } from './abbreviations.js';
export { chunk, DEFAULT_CHUNK_OPTIONS } from './chunker.js';
export type { SourceDoc, PageImage, Chunk, BoundingBox, ChunkOptions } from './chunker.js';
export { isImageOnly } from './chunker.js';
export type { Segmenter } from './sentences.js';
export { createTokenizer, foldForIndex } from './tokenizer.js';
export type { Token, Tokenizer, TokenizerOptions, WordSegmenter, Stemmer } from './tokenizer.js';
export { stemPlural, RSLP_S_FOLDED } from './stemmer.js';
export { luceneIdf, bm25TermScore, bm25Score, DEFAULT_BM25_PARAMS } from './bm25.js';
export type { Bm25Params, CorpusStats, ScoredTerm } from './bm25.js';
export {
    createIndex,
    createDenseIndex,
    loadIndex,
    CHUNKER_POLICY,
    INDEX_FORMAT_VERSION,
    // Exported to be READ, not tuned: a recall figure published without the k
    // and the depth that produced it cannot be compared with another one.
    FUSION_K,
    FUSION_DEPTH,
} from './index-build.js';
export type {
    DenseArm,
    DenseIndexOptions,
    Index,
    IndexArtifact,
    IndexBuildState,
    IndexOptions,
    SearchOptions,
    SearchResult,
    StoredChunk,
} from './index-build.js';
export { norm, normalize, dot, packVectors, unpackVectors } from './vector.js';
export {
    assertChunkCeilingFits,
    assertChunksFit,
    deterministicProvider,
    EmbeddingCheckError,
} from './embedding.js';
export type { EmbeddingCheckReason } from './embedding.js';
export type { EmbeddingProvider } from './embedding.js';
export { openAiProvider } from './providers/openai.js';
export { geminiProvider } from './providers/gemini.js';
export { qwenProvider } from './providers/qwen.js';
export { EmbeddingProviderError } from './providers/http.js';
export type { OpenAiOptions } from './providers/openai.js';
export type { GeminiOptions } from './providers/gemini.js';
export type { QwenOptions } from './providers/qwen.js';
export {
    attribute,
    attributeLexical,
    MIN_LEXICAL_SUPPORT,
    LEXICAL_MARGIN,
    DEFAULT_COALESCE_MAX_CODE_POINTS,
    DEFAULT_MIN_CLUSTER_CODE_POINTS,
    DEFAULT_GRANULARITY,
    DEFAULT_ATTRIBUTE_OPTIONS,
} from './attribute.js';
export type {
    Attribution,
    AttributionSpan,
    AttributeOptions,
    AttributionGranularity,
    RungCounts,
    ProviderFailure,
    AttributeState,
    ResolvedBy,
} from './attribute.js';
export { formatAttribution } from './format-attribution.js';
export type { FormattedAttribution, FormatOptions } from './format-attribution.js';
