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
};

describe('package contract', () => {
    it('declares zero runtime dependencies', () => {
        expect(pkg.dependencies ?? {}).toEqual({});
    });

    it('is native ESM', () => {
        expect(pkg.type).toBe('module');
    });

    it('publishes only the compiled output', () => {
        expect(pkg.files).toEqual(['dist']);
    });

    it('is Apache-2.0', () => {
        expect(pkg.license).toBe('Apache-2.0');
    });
});
