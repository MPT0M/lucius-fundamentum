/**
 * What the page is allowed to learn about the provider.
 *
 * It lives apart from `server.mjs` so a test can reach it without starting a
 * listener, and because it is the one place in this example where a key could
 * leak by accident: the server holds a configured provider and answers a
 * request about it. Returning the object itself, or spreading it, would be one
 * keystroke away from sending the credential to the browser.
 *
 * So the shape is built field by field, and the test asserts the field list
 * exactly rather than asserting the absence of a name somebody remembered to
 * forbid. A denial list only catches what it was told about; an allowlist
 * fails on anything new.
 */

/**
 * @param {import('../../dist/index.js').EmbeddingProvider | null} provider
 * @returns {{ configured: false } | { configured: true, id: string, dimensions: number, maxInputCodePoints: number, modalities: readonly string[] }}
 */
export function publicProviderShape(provider) {
    if (provider === null) return { configured: false };
    return {
        configured: true,
        id: provider.id,
        dimensions: provider.dimensions,
        maxInputCodePoints: provider.maxInputCodePoints,
        modalities: provider.modalities,
    };
}
