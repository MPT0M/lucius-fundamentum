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
export type { MaskOptions, ProtectedSpan, ClassifiedMaskResult } from './mask.js';
export { maskAbbreviationPeriods, PT_BR_ABBREVIATIONS } from './abbreviations.js';
export type { AbbreviationList } from './abbreviations.js';
export { chunk, DEFAULT_CHUNK_OPTIONS } from './chunker.js';
export type { SourceDoc, Chunk, BoundingBox, ChunkOptions, Segmenter } from './chunker.js';
