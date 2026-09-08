/**
 * The package ships with no runtime dependencies. This is a contract, not a
 * preference: the core has to fit inside a Cloudflare Worker's bundle budget
 * and run in a browser without a build step pulling in a stemmer or an HTTP
 * client. A dependency added by accident would pass every other test.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
        expect(typecheck.include).toEqual(expect.arrayContaining(['src', 'tests']));
        expect(typecheck.compilerOptions.types).toContain('node');
        expect(typecheck.compilerOptions.noEmit).toBe(true);
        expect(pkg.scripts?.typecheck).toContain('-p tsconfig.typecheck.json');
    });
});
