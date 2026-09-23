/**
 * The Node half of this example: this file and `server-paths.mjs`, which are
 * the only ones allowed to import `node:`.
 *
 * It exists for two reasons. A module script is subject to the same-origin
 * rules, so the page wants an HTTP origin rather than the filesystem. And this
 * process is where the API key lives: the browser sends text and receives
 * vectors, and never sees the key — a guarantee that rests on
 * `server-paths.mjs` refusing to serve the file the key is in, not on whatever
 * the page happens to load being polite.
 *
 * Node's http module and nothing else: an example that starts by installing a
 * web framework teaches the framework, not the package.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geminiProvider, openAiProvider, qwenProvider } from '../../dist/index.js';
import { resolveInsideRoot } from './server-paths.mjs';
import { publicProviderShape } from './server-provider.mjs';

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
 * The key, read from `.env` and never sent anywhere but the provider.
 *
 * Parsed by hand rather than with a dotenv package, because the package ships
 * zero dependencies and an example that installs one to read four lines
 * teaches the wrong lesson about what this costs.
 *
 * @returns {Record<string, string>}
 */
function readEnvFile() {
    /** @type {Record<string, string>} */
    const values = {};
    let raw = '';
    try {
        raw = readFileSync(join(HERE, '.env'), 'utf8');
    } catch {
        return values;
    }
    for (const line of raw.split('\n')) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (match === null || match[1] === undefined) continue;
        const value = (match[2] ?? '').replace(/^["']|["']$/g, '').trim();
        if (value !== '') values[match[1]] = value;
    }
    return values;
}

const env = readEnvFile();

/**
 * Picks the provider from whichever key was filled in.
 *
 * The choice belongs to whoever runs the bench, not to this file: the package
 * ships three adapters and the `.env` decides. Returning `null` is the
 * ordinary case, not an error — the bench is designed to be useful with no key
 * at all.
 *
 * @returns {import('../../dist/index.js').EmbeddingProvider | null}
 */
function chooseProvider() {
    if (env['GEMINI_API_KEY'] !== undefined) return geminiProvider({ apiKey: env['GEMINI_API_KEY'] });
    if (env['OPENAI_API_KEY'] !== undefined) return openAiProvider({ apiKey: env['OPENAI_API_KEY'] });
    if (env['QWEN_API_KEY'] !== undefined) {
        const baseUrl = env['QWEN_BASE_URL'];
        return qwenProvider(baseUrl === undefined ? { apiKey: env['QWEN_API_KEY'] } : { apiKey: env['QWEN_API_KEY'], baseUrl });
    }
    return null;
}

const provider = chooseProvider();

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

createServer(async (req, res) => {
    const urlPath = req.url ?? '/';
    if (urlPath === '/' || urlPath === '/index.html') {
        res.writeHead(302, { location: ENTRY }).end();
        return;
    }

    // What the page asks before offering anything that costs money. It answers
    // with the provider's identity and shape and never with the key.
    if (urlPath === '/provider') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(publicProviderShape(provider)));
        return;
    }

    if (urlPath === '/embed' && req.method === 'POST') {
        if (provider === null) {
            res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'no key in .env; copy .env.example and fill one in' }));
            return;
        }
        try {
            const body = await readJson(req);
            const vectors =
                body.kind === 'query'
                    ? [await provider.embedQuery(body.text)]
                    : await provider.embedDocuments(body.texts);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ vectors }));
        } catch (error) {
            // The provider's own status is forwarded when it had one, because
            // `retryable` downstream reads a NUMBER rather than prose: flatten
            // every failure to 500 here and a quota error becomes
            // indistinguishable from a bad key on the other side.
            const reported = /** @type {{ status?: unknown }} */ (error).status;
            const status = typeof reported === 'number' ? reported : 502;
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
    }

    const file = resolveInsideRoot(ROOT, urlPath);
    if (file === null) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('not a page asset');
        return;
    }

    try {
        const body = await readFile(file);
        // `no-store`, because this is a bench you edit while it is open. A
        // browser caches an ES module hard, and a stale one is the worst kind
        // of confusion here: the page runs code that is no longer on disk and
        // every measurement taken against it is about a file nobody has.
        res.writeHead(200, {
            'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
            'cache-control': 'no-store',
        });
        res.end(body);
    } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`no ${urlPath}`);
    }
}).listen(PORT, '127.0.0.1', () => {
    console.log(`bench on http://127.0.0.1:${PORT}${ENTRY}`);
    console.log(
        provider === null
            ? 'no key in .env — lexical only, which is the whole bench minus the dense arm'
            : `dense arm available via ${provider.id} (${provider.dimensions}d)`,
    );
});
