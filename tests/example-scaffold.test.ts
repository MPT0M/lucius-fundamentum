/**
 * The example is code in this repository, so it gets the same guards the
 * sources get.
 *
 * Two of them, and both already exist for `src/` — this file points them at
 * `examples/`. `scaffold.test.ts` proves the core reaches for nothing only
 * Node has, and it pins the second tsconfig so the guard cannot be dropped
 * without a failure. Neither reaches here on its own: the Node-free scan walks
 * `src/` and reads only `.ts`, and the pin names one config by hand.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import vitestConfig from '../vitest.config.js';

const ROOT = process.cwd();
const EXAMPLE = join(ROOT, 'examples', 'bancada');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
};

/**
 * The browser half of the example may not reach for Node, for the same reason
 * `src/` may not: it is loaded as-is by a browser, with no bundler to shim
 * anything. `server.mjs` is the exception and not an oversight — it IS the
 * Node process, and it is the only file here allowed to import `node:`.
 */
const NODE_ONLY_IMPORT = /\bfrom\s+['"]node:|\brequire\s*\(/;
const NODE_ONLY_GLOBAL = /\b(?:Buffer|process|__dirname|__filename)\b/;

/**
 * `server.mjs` IS the Node process, and a `*.test.js` runs under vitest in
 * Node — neither is loaded by a browser, so neither is bound by the rule.
 * Everything else here is.
 */
const SERVER = 'server.mjs';
const isBrowserModule = (name: string): boolean =>
    name !== SERVER && !name.endsWith('.test.js') && (name.endsWith('.js') || name.endsWith('.mjs'));

/**
 * Comments explain why Node is NOT used, so scanning raw source reports the
 * explanation as the violation. Same stripper as `scaffold.test.ts`: block
 * comments first, then `//` to end of line, but not the `//` inside a URL.
 */
function withoutComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
        .join('\n');
}

function browserFilesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return browserFilesUnder(full);
        return entry.isFile() && isBrowserModule(entry.name) ? [full] : [];
    });
}

describe('the example runs where there is no Node', () => {
    it('imports nothing from `node:` and calls no Node global, outside the server', () => {
        const offending = browserFilesUnder(EXAMPLE).flatMap((file) => {
            const code = withoutComments(readFileSync(file, 'utf8'));
            return code
                .split('\n')
                .map((text, i) => ({ file: relative(EXAMPLE, file), line: i + 1, text: text.trim() }))
                .filter((l) => NODE_ONLY_IMPORT.test(l.text) || NODE_ONLY_GLOBAL.test(l.text));
        });

        expect(offending, offending.map((o) => `${o.file}:${o.line}  ${o.text}`).join('\n')).toEqual([]);
    });

    it('scans something, so a rename cannot empty the sweep', () => {
        // Without this the guard above passes loudest when it is looking at
        // nothing: move the folder, or change the extension, and an empty list
        // of files yields an empty list of violations and a green test.
        const scanned = browserFilesUnder(EXAMPLE).map((f) => relative(EXAMPLE, f));
        expect(scanned).toContain('app.js');
        expect(scanned).toContain('bancada.js');
        expect(scanned).not.toContain(SERVER);
        expect(scanned).not.toContain('bancada.test.js');
    });

    it('rejects a Node import when it sees one', () => {
        // The control for the scanner itself: the regexes above are only worth
        // something if they fire. Feeding them a source they must reject
        // separates "nothing to find" from "cannot find anything".
        const planted = withoutComments("import { readFileSync } from 'node:fs';\nconst x = process.env.KEY;");
        const hits = planted
            .split('\n')
            .filter((text) => NODE_ONLY_IMPORT.test(text) || NODE_ONLY_GLOBAL.test(text));
        expect(hits).toHaveLength(2);
    });
});

describe('the example stays wired to the build', () => {
    it('type-checks the example with a config of its own', () => {
        const example = JSON.parse(
            readFileSync(join(ROOT, 'tsconfig.example.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
        ) as {
            include: string[];
            compilerOptions: { allowJs: boolean; checkJs: boolean; lib: string[]; noEmit: boolean };
        };

        expect(example.include).toEqual(['examples']);
        expect(example.compilerOptions.allowJs).toBe(true);
        expect(example.compilerOptions.checkJs).toBe(true);
        expect(example.compilerOptions.noEmit).toBe(true);
        // Declared, not inherited: the root sets ES2022 + WebWorker, which
        // declares no `document`. `lib` replaces rather than merges, so
        // dropping ES2022 from this list would silently remove it.
        expect(example.compilerOptions.lib).toEqual(['ES2022', 'DOM', 'DOM.Iterable']);
    });

    it('builds before it checks, because the example imports from dist/', () => {
        const script = pkg.scripts?.['typecheck:example'] ?? '';
        expect(script).toContain('-p tsconfig.example.json');
        // `dist/` is gitignored, so on a clean checkout the import resolves to
        // nothing and the check reports TS2307 instead of what it was asked
        // to find. Mapping the import to `src/` with `paths` was measured and
        // does not work: `paths` does not redirect a relative specifier.
        expect(script).toContain('npm run build');
    });

    it('runs that check in CI, after the build', () => {
        // Pinning the script alone leaves the real silent-drop open: the step
        // can be removed from the workflow and every local command still
        // passes. The order matters as much as the presence — before the
        // build, `dist/` does not exist yet.
        const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
        const build = ci.indexOf('npm run build');
        const checkExample = ci.indexOf('npm run typecheck:example');
        expect(build).toBeGreaterThan(-1);
        expect(checkExample).toBeGreaterThan(build);
    });

    it('runs the example tests as part of the suite', () => {
        // One glob is the only thing making `examples/**/*.test.js` part of
        // the suite. Dropping it leaves the suite green with fewer files and
        // nothing to say so — the same silent-drop `scaffold.test.ts` pins
        // the bench's glob against.
        const include = (vitestConfig as { test?: { include?: string[] } }).test?.include ?? [];
        expect(include).toContain('examples/**/*.test.js');
    });
});
