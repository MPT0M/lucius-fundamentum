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
 * anything. Files named `server*` and the test files are exempt, and that is
 * not an oversight — they ARE Node, and the exemption is spelled out where the
 * predicate lives.
 */
const NODE_ONLY_IMPORT = /\bfrom\s+['"]node:|\brequire\s*\(/;
const NODE_ONLY_GLOBAL = /\b(?:Buffer|process|__dirname|__filename)\b/;

/**
 * Files named `server*` ARE the Node process, and a `*.test.js` runs under
 * vitest in Node — neither is loaded by a browser, so neither is bound by the
 * rule. Everything else here is.
 *
 * The prefix rather than one file name, because the server's rules are worth
 * extracting into modules a test can import without starting a listener, and
 * each of those is Node by the same right the server is.
 */
const isServer = (name: string): boolean => name.startsWith('server');
const isBrowserModule = (name: string): boolean =>
    !isServer(name) && !name.endsWith('.test.js') && (name.endsWith('.js') || name.endsWith('.mjs'));

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
        for (const name of ['app.js', 'bancada.js', 'pdf.js', 'storage.js', 'dc.js', 'proto-logic.js', 'registers.js']) {
            expect(scanned, name).toContain(name);
        }
        for (const name of ['server.mjs', 'server-paths.mjs', 'server-provider.mjs', 'bancada.test.js', 'server.test.js', 'dc.test.js']) {
            expect(scanned, name).not.toContain(name);
        }
        // A count as well as the names: naming the files proves those are
        // seen, and says nothing about one more arriving unscanned.
        expect(scanned).toHaveLength(7);
    });

    it('detects every shape it is supposed to detect', () => {
        // The control for the scanner itself. Without it the sweep passes on
        // a regex that matches nothing as loudly as on a clean directory, and
        // the two are not the same result. Same five shapes `scaffold.test.ts`
        // feeds its own guard.
        const violations = [
            "import { readFileSync } from 'node:fs';",
            'const fs = require("fs");',
            'const b = Buffer.from(text);',
            'const n = process.env.PORT;',
            'const here = __dirname;',
        ];
        for (const line of violations) {
            const code = withoutComments(line);
            expect(NODE_ONLY_IMPORT.test(code) || NODE_ONLY_GLOBAL.test(code), line).toBe(true);
        }
    });

    it('does not fire on the comments that explain the absence', () => {
        // The third way the sweep passes while blind: a stripper that ate the
        // file leaves nothing to match. These are the real shapes from this
        // folder — comments that name `process` and `node:` in order to say
        // they are NOT used. A stripper that missed them would make the guard
        // unusable, and the obvious repair would be to loosen the pattern,
        // which removes the guard instead of fixing it.
        const explanation = [
            '/** The only Node here: it imports node:http, and nothing else may. */',
            'const x = 1; // never reads process.env in the browser half',
        ].join('\n');
        const stripped = withoutComments(explanation);

        expect(NODE_ONLY_IMPORT.test(stripped)).toBe(false);
        expect(NODE_ONLY_GLOBAL.test(stripped)).toBe(false);
        // And the stripper did not simply eat everything, which would pass the
        // two assertions above for the wrong reason.
        expect(stripped).toContain('const x = 1;');
    });

    it('reaches no origin the page has not declared', () => {
        // The bench's subject is where your documents go, and the screen makes
        // a promise about it in words. Three external origins arrived in one
        // batch without the suite noticing, so the set is pinned: a new one
        // fails here and has to be declared in the header comment above the
        // markup, where a reader looking for this actually looks.
        //
        // The MODULES are swept too, not only the page. The CDN that pdf.js
        // comes from lives in `pdf.js`, and it is the one origin a visitor
        // actually downloads megabytes from — a guard that read the markup
        // alone would pin two of the three while the declaration promised all
        // three. `w3.org` is the SVG namespace, which is an identifier in an
        // attribute and not a request.
        const sources = [readFileSync(join(EXAMPLE, 'index.html'), 'utf8'), ...browserFilesUnder(EXAMPLE).map((f) => readFileSync(f, 'utf8'))];
        const origins = sources.flatMap((text) => [...text.matchAll(/https?:\/\/([^/"'`\s)]+)/g)].map((m) => m[1] ?? ''));

        expect([...new Set(origins)].sort()).toEqual([
            'cdn.jsdelivr.net',
            'fonts.googleapis.com',
            'fonts.gstatic.com',
            'www.w3.org',
        ]);
    });

    it('says in the page what the page fetches', () => {
        // The declaration itself, so removing the sentence is a failure rather
        // than a silent loss. It went missing once already, in the port.
        const html = readFileSync(join(EXAMPLE, 'index.html'), 'utf8');
        expect(html).toContain('WHAT THIS PAGE FETCHES');
        expect(html).toContain('pdf.js from a CDN');
    });

    it('quotes the promise exactly as the screen words it', () => {
        // The promise the bench makes about where documents go lives in two
        // files: `proto-logic.js` puts it on the screen, and the docblock of
        // `providerMayBeAsked` quotes it to say what the function is for. They
        // diverged the first time the wording changed — the quotation went on
        // promising something the screen no longer said, in the one comment
        // whose job is to state that the guarantee holds.
        const shown = readFileSync(join(EXAMPLE, 'proto-logic.js'), 'utf8');
        const quoted = readFileSync(join(EXAMPLE, 'bancada.js'), 'utf8');
        const note = /Matches words only\. ([^']+)'/.exec(shown)?.[1] ?? '';

        expect(note).not.toBe('');
        expect(quoted).toContain(note);
    });

    it('leaves no script the sweep cannot see', () => {
        // The sweep reads `.js` by design, so a `<script>` with a body in the
        // page would be JavaScript that no guard here ever looks at. Keeping
        // every line of script in a module file is what makes the sweep
        // complete rather than merely green.
        const html = readFileSync(join(EXAMPLE, 'index.html'), 'utf8');
        const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(
            ([, , body]) => (body ?? '').trim() !== '',
        );
        expect(inline.map(([, attrs]) => attrs)).toEqual([]);
    });
});

describe('the example stays wired to the build', () => {
    it('type-checks the example with a config of its own', () => {
        const example = JSON.parse(
            readFileSync(join(ROOT, 'tsconfig.example.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
        ) as {
            extends: string;
            include: string[];
            compilerOptions: { allowJs: boolean; checkJs: boolean; lib: string[]; noEmit: boolean; types: string[] };
        };

        expect(example.include).toEqual(['examples']);
        // `strict`, `exactOptionalPropertyTypes` and the rest reach the
        // example ONLY by inheritance. Drop this line and the config still
        // type-checks something, just not with the discipline the sources
        // get — which is the whole claim the file is built on.
        expect(example.extends).toBe('./tsconfig.json');
        expect(example.compilerOptions.types).toEqual(['node']);
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
        const build = script.indexOf('npm run build');
        const check = script.indexOf('-p tsconfig.example.json');

        expect(check).toBeGreaterThan(-1);
        // ORDER, not presence. Both strings appear in
        // `tsc ... && npm run build` too, and that arrangement is the one
        // this test exists to forbid.
        expect(build).toBeGreaterThan(-1);
        expect(check).toBeGreaterThan(build);
        // `dist/` is gitignored, so on a clean checkout the import resolves to
        // nothing and the check reports TS2307 instead of what it was asked
        // to find. Mapping the import to `src/` with `paths` was measured and
        // does not work: `paths` does not redirect a relative specifier.
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

    it('runs the suite after the build too, because the example tests import dist/', () => {
        // The example's tests import `../../dist/`, so the suite now depends
        // on the build in a way it never did: every other test reads `src/`.
        // On a clean checkout `npm test` before `npm run build` is red, which
        // is loud. Against a STALE `dist/` it is green, and those cases pin
        // the previous build while the rest pin the new sources — the quiet
        // version, and the one worth a guard.
        const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
        expect(ci.indexOf('npm test')).toBeGreaterThan(ci.indexOf('npm run build'));
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

/**
 * The switch over the composer promises, in words, that a question stays local
 * while it is off. Three paths in `app.js` could break that promise, and two of
 * them did: they read `denseArm === 'ready'` and went to the network on their
 * own reading of the state, with no idea what the screen had told the person.
 *
 * The guard is on the source text because the promise is not a value a unit
 * test can hold — `providerMayBeAsked` has its own tests, and they stay green
 * while a fourth path grows beside it that never calls it.
 */
const ARM_COMPARED_DIRECTLY = /\bdenseArm\b\s*[!=]==|['"]ready['"]\s*[!=]==|[!=]==\s*['"]ready['"]/;

describe('the bench asks the screen before it asks the provider', () => {
    const app = (): string => withoutComments(readFileSync(join(EXAMPLE, 'app.js'), 'utf8'));

    it('compares `denseArm` with nothing, anywhere in `app.js`', () => {
        expect(app()).not.toMatch(ARM_COMPARED_DIRECTLY);
    });

    it('routes the network-bound paths through that predicate', () => {
        // Without this the guard above passes on a file that dropped the
        // predicate entirely, which is the same defect with the evidence
        // removed.
        expect(app()).toContain('providerMayBeAsked(');
    });

    it('detects the shape it is supposed to detect', () => {
        // The control the other two rest on: a pattern that matches nothing
        // reports a clean file and a deleted file alike.
        expect("const hits = index.denseArm === 'ready' ? a : b;").toMatch(ARM_COMPARED_DIRECTLY);
        // The two shapes the first pattern missed: a negation, and the
        // comparison written the other way round after an alias. Either one
        // is a decision about the arm taken outside the predicate, and the
        // guard has to see both or a one-line rename defeats it.
        expect("if (arm !== 'ready') return;").toMatch(ARM_COMPARED_DIRECTLY);
        expect("if ('ready' === arm) go();").toMatch(ARM_COMPARED_DIRECTLY);
    });
});

/**
 * `data-ref` is a contract between two files that nobody checks at runtime.
 *
 * The page names a ref; the component decides what to do with the element.
 * When the two disagree nothing throws — every reader is guarded by `?.` or an
 * `if`, so a dead ref is a feature that silently stops happening. Five did at
 * once: the divider stopped resizing, "Send a file" stopped opening the picker,
 * the composer stopped clearing, the new block stopped scrolling into view, and
 * the attach menu stopped closing on an outside click.
 */
describe('every ref the page names is one the component answers to', () => {
    const page = (): string => readFileSync(join(EXAMPLE, 'index.html'), 'utf8');
    const logic = (): string => readFileSync(join(EXAMPLE, 'proto-logic.js'), 'utf8');

    const refsNamed = (html: string): string[] => [...html.matchAll(/data-ref="([^"]+)"/g)].map((m) => m[1] ?? '');

    it('finds the refs, so a rename cannot empty this sweep', () => {
        expect(refsNamed(page()).length).toBeGreaterThan(0);
    });

    it('has a `renderVals` entry for each of them', () => {
        // This is the half a source sweep can prove: the name exists on both
        // sides. It was TRUE while the five refs were dead — the entries were
        // all there and the runtime never called them — so it is written here
        // as what it is, a check against a rename, and `dc.test.js` is what
        // covers the behaviour that actually failed.
        const source = logic();
        const missing = refsNamed(page()).filter((ref) => !new RegExp(String.raw`\b${ref}:`).test(source));
        expect(missing).toEqual([]);
    });

    it('detects a name the component never declares', () => {
        // The control. Without it the check above passes on any regex that
        // matches everything — which is how it was first written: a `\b` in a
        // template literal became a backspace character, the pattern matched
        // nothing, and the failure read like a real finding.
        const source = logic();
        expect(new RegExp(String.raw`\bnoSuchRef:`).test(source)).toBe(false);
        expect(new RegExp(String.raw`\bgroundRef:`).test(source)).toBe(true);
    });
});
