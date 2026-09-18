/**
 * The package ships with no runtime dependencies. This is a contract, not a
 * preference: the core has to fit inside a Cloudflare Worker's bundle budget
 * and run in a browser without a build step pulling in a stemmer or an HTTP
 * client. A dependency added by accident would pass every other test.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import vitestConfig from '../vitest.config.js';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    type?: string;
    files?: string[];
    license?: string;
    scripts?: Record<string, string>;
};

describe('package contract', () => {
    it('declares zero runtime dependencies', () => {
        expect(pkg.dependencies ?? {}).toEqual({});
    });

    it('is native ESM', () => {
        expect(pkg.type).toBe('module');
    });

    it('publishes the compiled output and the NOTICE, nothing else', () => {
        // Deliberate contract change with the abbreviation list: NOTICE carries
        // the attribution Apache-2.0 §4(d) requires on redistribution, and npm
        // does not include it on its own (it does LICENSE and README). Source,
        // tests and configs still stay out of the tarball.
        expect(pkg.files).toEqual(['dist', 'NOTICE']);
    });

    it('is Apache-2.0', () => {
        expect(pkg.license).toBe('Apache-2.0');
    });

    it('type-checks the tests with the same tsc that checks the sources', () => {
        // Vitest transpiles a test without checking its types, so a read in
        // tests/ whose only check is the declared type — the value is still
        // there at runtime, the type stopped promising it — is verified by
        // nothing unless tsc reads tests/, which the root tsconfig does not
        // (include: src). This pins the second config and the script that
        // runs it, so the guard cannot be silently dropped.
        const typecheck = JSON.parse(readFileSync(join(process.cwd(), 'tsconfig.typecheck.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')) as {
            include: string[];
            compilerOptions: { types: string[]; noEmit: boolean };
        };
        expect(typecheck.include).toEqual(expect.arrayContaining(['src', 'tests', 'bench', 'vitest.config.ts']));
        expect(typecheck.compilerOptions.types).toContain('node');
        expect(typecheck.compilerOptions.noEmit).toBe(true);
        expect(pkg.scripts?.typecheck).toContain('-p tsconfig.typecheck.json');
    });

    it('runs the harness tests under bench/ as part of the suite', () => {
        // The only thing that makes bench/src/*.test.ts part of the suite is
        // one glob in vitest.config.ts. Dropping it leaves the suite green with
        // one file fewer and nothing to say so — the same silent-drop the
        // typecheck pin above exists to prevent, for the twin wiring. The cast
        // narrows `defineConfig`'s union (object | function | promise) to the
        // object this repo exports; if the shape changed, `include` would be
        // empty and both assertions would fail loudly.
        const include = (vitestConfig as { test?: { include?: string[] } }).test?.include ?? [];
        expect(include).toContain('bench/src/**/*.test.ts');
        expect(include).toContain('tests/**/*.test.ts');
    });
});

/**
 * Zero dependencies is half the promise; the other half is that `src/` never
 * reaches for something only Node has. Nothing enforced it. A
 * `import { readFileSync } from 'node:fs'` added here type-checks, builds and
 * leaves the suite green, and the failure surfaces in a browser that loads the
 * package — far from the line that caused it, and only once someone has built
 * an interface on top.
 *
 * `vector.ts` already avoids `Buffer` deliberately and says so in a comment.
 * This is that decision with a guard under it.
 */
const NODE_ONLY_IMPORT = /\bfrom\s+['"]node:|\brequire\s*\(/;
const NODE_ONLY_GLOBAL = /\b(?:Buffer|process|__dirname|__filename)\b/;

/**
 * Comments mention `Buffer` and `process.env` to explain why they are NOT
 * used, so scanning raw source reports the explanation as the violation. Block
 * comments go first; then `//` to end of line, but not the `//` inside a URL.
 *
 * It removes a trailing `//` inside a string literal too, which can only hide
 * a violation sharing that line — the reason the control below feeds the
 * scanner sources it must reject rather than trusting the expression.
 */
function withoutComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
        .join('\n');
}

function sourceFilesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return sourceFilesUnder(full);
        return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
    });
}

describe('the core runs where there is no Node', () => {
    const root = join(process.cwd(), 'src');

    it('imports nothing from `node:` and calls no Node global', () => {
        const offending = sourceFilesUnder(root).flatMap((file) => {
            const code = withoutComments(readFileSync(file, 'utf8'));
            return code
                .split('\n')
                .map((text, i) => ({ file: relative(root, file), line: i + 1, text: text.trim() }))
                .filter((l) => NODE_ONLY_IMPORT.test(l.text) || NODE_ONLY_GLOBAL.test(l.text));
        });

        expect(offending, offending.map((o) => `${o.file}:${o.line}  ${o.text}`).join('\n')).toEqual(
            [],
        );
    });

    it('detects every shape it is supposed to detect', () => {
        // Without this the test above passes on an empty directory, on a
        // regex that matches nothing, and on a comment stripper that ate the
        // file. Each line below is a real way the promise has been broken.
        const violations = [
            "import { readFileSync } from 'node:fs';",
            'const fs = require("fs");',
            'const b = Buffer.from(text);',
            'const n = process.env.CONCURRENCY;',
            'const here = __dirname;',
        ];
        for (const line of violations) {
            const code = withoutComments(line);
            expect(
                NODE_ONLY_IMPORT.test(code) || NODE_ONLY_GLOBAL.test(code),
                line,
            ).toBe(true);
        }
    });

    it('does not fire on the comments that explain the absence', () => {
        // The two real ones, verbatim from `src/`. A stripper that missed
        // them would make the guard unusable and the obvious repair would be
        // to loosen the pattern, which removes the guard instead.
        const harmless = [
            ' * `Buffer` is Node-only and this library has to run in a Worker; `btoa` takes',
            ' * the option that caused it. `Number(process.env.CONCURRENCY)` on an unset',
            "const base = 'https://generativelanguage.googleapis.com/v1beta';",
        ];
        for (const line of harmless) {
            const code = withoutComments(`/**\n${line}\n */`);
            expect(NODE_ONLY_IMPORT.test(code) || NODE_ONLY_GLOBAL.test(code), line).toBe(false);
        }
    });
});
