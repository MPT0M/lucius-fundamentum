import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Assembled from pieces so that the planted fixture below does not appear as a
 * literal path in this source. What actually keeps this file out of the scan is
 * `excludeFiles` in the first test — this is belt, that is braces.
 */
const WIN_PREFIX = ['C', ':', '\\', 'Users', '\\'].join('');
const PERSONAL_PATH_SHAPES: readonly RegExp[] = [
    new RegExp('[A-Za-z]:\\\\Users\\\\[^\\\\/\\s"\'<>|]+'),
    new RegExp('/home/[^/\\s"\'<>|]+'),
    new RegExp('/Users/[^/\\s"\'<>|]+'),
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);

interface Hit {
    readonly file: string;
    readonly line: number;
    readonly text: string;
}

/** Every regular file under `root`, skipping build output and dependencies. */
function walk(root: string, dir: string = root, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(root, full, out);
        else out.push(full);
    }
    return out;
}

/**
 * Scans a tree for personal-path shapes. `excludeFiles` are repo-relative paths
 * (forward slashes) that are allowed to mention the shapes — this test file is
 * the only legitimate one.
 */
export function scanForPersonalPaths(root: string, excludeFiles: readonly string[] = []): Hit[] {
    const excluded = new Set(excludeFiles);
    const hits: Hit[] = [];
    for (const file of walk(root)) {
        const rel = relative(root, file).split(sep).join('/');
        if (excluded.has(rel)) continue;
        let content: string;
        try {
            content = readFileSync(file, 'utf8');
        } catch {
            continue; // binary or unreadable: not text, not a leak vector
        }
        content.split('\n').forEach((text, i) => {
            if (PERSONAL_PATH_SHAPES.some((re) => re.test(text))) {
                hits.push({ file: rel, line: i + 1, text: text.trim() });
            }
        });
    }
    return hits;
}

const REPO_ROOT = process.cwd();
const THIS_FILE = 'tests/leak-guard.test.ts';

describe('leak guard — the tracked tree', () => {
    it('contains no path with a username in it', () => {
        const hits = scanForPersonalPaths(REPO_ROOT, [THIS_FILE]);
        expect(hits, hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join('\n')).toEqual([]);
    });

    it('has no commit message with a path with a username in it', () => {
        let log: string;
        try {
            log = execFileSync('git', ['log', '--format=%B'], { cwd: REPO_ROOT, encoding: 'utf8' });
        } catch {
            return; // no git in this environment: nothing to scan
        }
        const offending = log.split('\n').filter((l) => PERSONAL_PATH_SHAPES.some((re) => re.test(l)));
        expect(offending).toEqual([]);
    });
});

describe('leak guard — it can actually fire', () => {
    // A guard that cannot fail proves nothing. Plant each shape in a scratch
    // tree and confirm the scanner reports it, so "the tree is clean" above is
    // a measurement and not a guess.
    it('detects every shape it is supposed to detect', () => {
        const dir = mkdtempSync(join(tmpdir(), 'leak-guard-'));
        try {
            writeFileSync(join(dir, 'a.md'), `see ${WIN_PREFIX}alice\\work\\notes.txt`, 'utf8');
            writeFileSync(join(dir, 'b.ts'), 'const p = "/home/bob/repo";', 'utf8');
            writeFileSync(join(dir, 'c.yml'), 'path: /Users/carol/Desktop', 'utf8');
            writeFileSync(join(dir, 'clean.txt'), 'nothing to see here', 'utf8');

            const hits = scanForPersonalPaths(dir);
            expect(hits.map((h) => h.file).sort()).toEqual(['a.md', 'b.ts', 'c.yml']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('does not fire on paths without a username segment', () => {
        const dir = mkdtempSync(join(tmpdir(), 'leak-guard-'));
        try {
            writeFileSync(join(dir, 'ok.md'), 'C:\\Windows\\System32 and /usr/local/bin and /home', 'utf8');
            expect(scanForPersonalPaths(dir)).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
