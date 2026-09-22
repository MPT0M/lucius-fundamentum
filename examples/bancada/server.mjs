/**
 * The only Node in this example, and the only file here allowed to import it.
 *
 * It exists for two reasons, and the second is the one that matters later. A
 * module script is subject to the same-origin rules, so the page wants an HTTP
 * origin rather than the filesystem; and from the commit that lights the dense
 * arm, this process is where the API key lives. The browser sends text and
 * receives vectors, and never sees the key.
 *
 * Node's http module and nothing else: an example that starts by installing a
 * web framework teaches the framework, not the package.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// The document root is the repository, not this folder: the page loads the
// package from `../../dist/`, so that path has to resolve over HTTP too.
const ROOT = resolve(HERE, '..', '..');
const ENTRY = '/examples/bancada/index.html';
const PORT = Number(process.env.PORT ?? 8123);

/** @type {Record<string, string>} */
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.wasm': 'application/wasm',
};

/**
 * The build has to have run, and saying so here is the difference between a
 * legible error and a blank page. Without this, the page loads, the module
 * import 404s, and the only trace is a console message in a devtools panel the
 * person may not have open — far from the command that caused it.
 */
if (!existsSync(join(ROOT, 'dist', 'index.js'))) {
    console.error('dist/ is missing. Run `npm run build` first, or `npm run example`, which does both.');
    process.exit(1);
}

/**
 * Keeps a request inside the document root.
 *
 * `..` in a URL is normally collapsed by the client, but a request does not
 * have to come from a browser, and a static server that reads whatever path it
 * is handed serves the whole disk.
 *
 * @param {string} urlPath
 * @returns {string | null} an absolute path inside ROOT, or null
 */
function resolveInsideRoot(urlPath) {
    const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
    const target = resolve(ROOT, `.${decoded}`);
    const rel = relative(ROOT, target);
    if (rel.startsWith('..') || rel.startsWith(`..${sep}`)) return null;
    return target;
}

createServer(async (req, res) => {
    const urlPath = req.url ?? '/';
    if (urlPath === '/' || urlPath === '/index.html') {
        res.writeHead(302, { location: ENTRY }).end();
        return;
    }

    const file = resolveInsideRoot(urlPath);
    if (file === null) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('outside the document root');
        return;
    }

    try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
    } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`no ${urlPath}`);
    }
}).listen(PORT, '127.0.0.1', () => {
    console.log(`bench on http://127.0.0.1:${PORT}${ENTRY}`);
});
