/**
 * Which files the bench's server is allowed to hand out.
 *
 * It lives apart from `server.mjs` so a test can reach it without starting a
 * listener, and because it is the one rule here worth pinning: the document
 * root is the whole repository — the page loads the package from `../../dist/`,
 * so that path has to resolve over HTTP — and a root that wide needs a rule
 * about what inside it is NOT a page asset.
 */

import { relative, resolve, sep } from 'node:path';

/**
 * Resolves a request path inside the document root, or refuses it.
 *
 * Two refusals, and they guard different things.
 *
 * **Escaping the root.** `..` in a URL is normally collapsed by the client, but
 * a request does not have to come from a browser, and a static server that
 * reads whatever path it is handed serves the whole disk.
 *
 * **A dotfile inside the root.** A dotfile under a document root is never a
 * page asset, and this process keeps its API key in one of them — the whole
 * account, billed to a card. Without this the guarantee the bench is built on
 * is false: any script running on the page, including a third-party module
 * fetched from a CDN, can read a same-origin path, so `.env` would be one
 * `fetch` away from anything the page loads. The same refusal covers `.git`,
 * which holds the repository's history and remotes.
 *
 * `node_modules` goes with them: nothing there is served on purpose, and
 * handing out an entire dependency tree over HTTP is surface with no use.
 *
 * @param {string} root absolute path of the document root
 * @param {string} urlPath the request path, possibly with a query string
 * @returns {string | null} an absolute path inside `root`, or null when refused
 */
export function resolveInsideRoot(root, urlPath) {
    /** @type {string} */
    let decoded;
    try {
        decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
    } catch {
        // **A malformed escape is a third refusal, and it belongs here.**
        // `decodeURIComponent('/%')` throws `URIError`, and the caller is an
        // async request handler: the throw became an unhandled rejection and
        // Node took the process down with it. Measured, not reasoned about —
        // one `curl http://127.0.0.1:8123/%` and the next request to a good
        // path answered nothing, because there was no longer a server.
        //
        // `null` rather than a re-throw because that is what this function
        // already means by "not a page asset": deciding whether a string is a
        // servable path is this file's job, and a string that is not a path at
        // all is the easiest case of it.
        return null;
    }
    const target = resolve(root, `.${decoded}`);
    const rel = relative(root, target);

    if (rel.startsWith('..') || rel.startsWith(`..${sep}`)) return null;
    if (rel.split(sep).some((segment) => segment.startsWith('.') || segment === 'node_modules')) return null;

    return target;
}
