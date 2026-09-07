/**
 * @nihilo-dev/fundamentum — public surface.
 *
 * Everything the package exports passes through this file. Nothing else under
 * src/ is a public path.
 */

export type { Span } from './types.js';
export { countCodePoints, normalizeUnicode, sliceByCodePoints } from './unicode.js';
