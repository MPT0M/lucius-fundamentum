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
