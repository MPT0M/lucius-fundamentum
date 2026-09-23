/**
 * The Node half of the bench: the two rules the server runs on.
 *
 * Beside their subject rather than in `tests/`, for the reason the example's
 * other tests are: a `.ts` test cannot import a JSDoc-typed `.mjs` without
 * `allowJs`, and turning that on for the main type-check config pulls in files
 * this example has no business touching. The type-checker said so out loud —
 * TS7016 — the first time these lived there.
 */

import { describe, it, expect } from 'vitest';
import { resolveInsideRoot } from './server-paths.mjs';
import { publicProviderShape } from './server-provider.mjs';

describe('the bench server hands out page assets and nothing else', () => {
    // The document root is the whole repository, because the page loads the
    // package from `../../dist/` and that path has to resolve over HTTP. A
    // root that wide is what makes this rule necessary rather than decorative:
    // the API key lives in a dotfile inside it, and any script the page loads
    // — including a third-party module fetched from a CDN — can read a
    // same-origin path.
    const ROOT_DIR = '/repo';

    it('refuses the file the key lives in', () => {
        expect(resolveInsideRoot(ROOT_DIR, '/examples/bancada/.env')).toBeNull();
    });

    it('refuses the repository history, which holds remotes', () => {
        expect(resolveInsideRoot(ROOT_DIR, '/.git/config')).toBeNull();
    });

    it('refuses the dependency tree, which is surface with no use', () => {
        expect(resolveInsideRoot(ROOT_DIR, '/node_modules/vitest/package.json')).toBeNull();
    });

    it('still serves the package, which the page cannot work without', () => {
        // The control: a rule that refused everything would pass the three
        // above and break the bench.
        expect(resolveInsideRoot(ROOT_DIR, '/dist/index.js')).not.toBeNull();
        expect(resolveInsideRoot(ROOT_DIR, '/examples/bancada/app.js')).not.toBeNull();
    });

    it('still refuses to leave the root', () => {
        expect(resolveInsideRoot(ROOT_DIR, '/../../etc/passwd')).toBeNull();
    });

    it('reads the path and not the query string', () => {
        expect(resolveInsideRoot(ROOT_DIR, '/examples/bancada/.env?x=1')).toBeNull();
    });
});

describe('the page learns the provider shape and never the key', () => {
    // This is where a leak is actually possible: the server holds a configured
    // provider and answers a question about it. `remoteProvider` cannot leak
    // one — there is no key in its scope — so a guard pointed there measures
    // nothing. This one is pointed at the place that holds the credential.
    const withKey = {
        id: 'gemini-embedding-2',
        dimensions: 1536,
        maxInputCodePoints: 2048,
        modalities: ['text'],
        apiKey: 'FAKE-NOT-A-REAL-KEY',
        embedDocuments: async () => [],
        embedQuery: async () => [],
    };

    it('answers with exactly five fields and no sixth', () => {
        // The field list, not a search for forbidden names: an allowlist fails
        // on anything new, and a denial list only catches what someone
        // remembered to forbid.
        const shape = publicProviderShape(/** @type {never} */ (withKey));
        expect(Object.keys(shape).sort()).toEqual([
            'configured',
            'dimensions',
            'id',
            'maxInputCodePoints',
            'modalities',
        ]);
        expect(JSON.stringify(shape)).not.toContain('FAKE-NOT-A-REAL-KEY');
    });

    it('says only that nothing is configured when there is no provider', () => {
        expect(publicProviderShape(null)).toEqual({ configured: false });
    });
});
