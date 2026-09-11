import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
    LABELED_PREFIX,
    labelMatchesResponse,
    validateLabeledFixture,
    validateManifest,
    type Manifest,
    type ManifestEntry,
} from '../bench/src/manifest.js';
import type { GoogleRawFixture } from '../bench/src/fixture.js';
import type { LabeledFixture } from '../bench/src/score.js';
import { actNumber, citationGraph } from '../bench/src/corpus-probe.js';
// The labeler allowlist has one home, read by this test and by the harness
// that scores labels kept outside the repository; the owner adds handles there.
import { ALLOWED_LABELERS } from '../bench/src/allowlists.js';

/**
 * The license allowlist lives HERE, where the suite runs it, and the owner adds
 * to it. `public-domain-law` is text that is public domain by statute
 * (Brazilian legislation, Lei 9.610 art. 8); `public-domain-term` is a work
 * whose protection has expired, verified work by work. Nothing share-alike,
 * nothing that asks for attribution: the corpus feeds a harness whose output
 * is kept, and a derived artifact would carry the origin's obligation.
 */
const ALLOWED_CORPUS_LICENSES = ['public-domain-law', 'public-domain-term'] as const;

// `import.meta.dirname` needs Node 20.11; the package promises >= 20, so the URL form is used.
const REPO_BENCH = fileURLToPath(new URL('../bench/', import.meta.url));

/** The directories the manifest governs. Anything else under `bench/` is code, not corpus. */
const GOVERNED_DIRS = ['corpus/public', 'fixtures/google', 'fixtures/labeled'];
const LABELED_DIR = 'fixtures/labeled';

/** The corpus directory's own license files are not documents of the corpus. */
const EXEMPT_FILES = new Set(['corpus/public/LICENSE', 'corpus/public/NOTICE']);

/**
 * The manifest's path form: relative to `bench/`, POSIX separators — whatever
 * the OS handed us. `rel` is the platform's `relative`; the test passes the
 * Windows and the POSIX implementations explicitly, because the CI host is
 * Linux and a backslash is an ordinary character to its `relative`.
 */
function toManifestPath(benchRoot: string, absolute: string, rel: typeof relative = relative): string {
    return rel(benchRoot, absolute).split('\\').join('/');
}

function filesUnder(benchRoot: string, dir: string): string[] {
    const root = join(benchRoot, dir);
    if (!existsSync(root)) return [];
    const out: string[] = [];
    const walk = (d: string): void => {
        for (const name of readdirSync(d)) {
            const full = join(d, name);
            if (statSync(full).isDirectory()) walk(full);
            else out.push(toManifestPath(benchRoot, full));
        }
    };
    walk(root);
    return out;
}

function readJson<T>(benchRoot: string, path: string): T {
    return JSON.parse(readFileSync(join(benchRoot, path), 'utf8')) as T;
}

/**
 * Everything the manifest promises about one `bench/` tree, as a list of
 * problems. Runs against the repository's own tree and against a temporary
 * tree built by the tests below, so the rules and the walk are proven by the
 * same code that guards the real corpus.
 */
function checkTree(benchRoot: string): string[] {
    const manifest = readJson<Manifest>(benchRoot, 'corpus/manifest.json');
    const present = GOVERNED_DIRS.flatMap((dir) => filesUnder(benchRoot, dir)).filter((p) => !EXEMPT_FILES.has(p));
    const problems = validateManifest(manifest, present, ALLOWED_CORPUS_LICENSES);

    const byPath = new Map(manifest.entries.map((e) => [e.path, e] as const));
    const byId = new Map(manifest.entries.map((e) => [e.id, e] as const));

    // Driven by the disk, not by the id: every file filed as a label is opened,
    // and one whose entry lacks the prefix is refused, not skipped.
    for (const path of filesUnder(benchRoot, LABELED_DIR)) {
        const entry = byPath.get(path);
        if (entry === undefined) continue; // already reported by validateManifest
        if (entry.kind !== 'derived' || !entry.id.startsWith(LABELED_PREFIX)) {
            problems.push(`label file "${path}" is filed under id "${entry.id}", which is not a derived "${LABELED_PREFIX}<id>" entry`);
            continue;
        }
        const labeled = readJson<LabeledFixture>(benchRoot, path);
        problems.push(...validateLabeledFixture(labeled, entry.derivedFrom, ALLOWED_LABELERS));
        const rawEntry = byId.get(entry.id.slice(LABELED_PREFIX.length));
        // A missing response, a response that is not a derived entry, or a
        // response whose file is absent were all reported by validateManifest.
        if (rawEntry === undefined || rawEntry.kind !== 'derived' || !existsSync(join(benchRoot, rawEntry.path))) continue;
        const raw = readJson<GoogleRawFixture>(benchRoot, rawEntry.path);
        if (raw.id !== rawEntry.id) {
            problems.push(`response file "${rawEntry.path}" says id "${raw.id}", but the manifest files it as "${rawEntry.id}"`);
        }
        problems.push(...labelMatchesResponse(labeled, raw));
    }
    return problems;
}

describe('the corpus manifest is the one source of provenance', () => {
    it('the repository tree: every governed file has an entry, every entry has a file, every source carries an allowed license, every label is well-formed and matches its response', () => {
        expect(checkTree(REPO_BENCH)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// A temporary tree proves the walk and the rules end to end, including what the
// repository tree cannot exercise while the corpus is empty.
// ---------------------------------------------------------------------------

const RAW: GoogleRawFixture = {
    id: 'r1',
    model: 'm',
    recordedAt: '2026-09-08',
    reportVersion: 'v',
    storeEmbeddingModel: 'e',
    storeChunking: { maxTokensPerChunk: 100, maxOverlapTokens: 10 },
    parts: [{ text: 'Frase um. Frase dois.' }],
    usageMetadata: { toolUsePromptTokenCount: 1 },
    groundingMetadata: { groundingChunks: [], groundingSupports: [] },
};

const LABEL: LabeledFixture = {
    id: 'r1',
    parts: RAW.parts,
    segments: [{ partIndex: 0, textSpan: { start: 0, end: 9 }, sourceSpans: [{ documentId: 'lei-1', span: { start: 0, end: 5 } }] }],
    labeledBy: 'MPT0M',
    labeledAt: '2026-09-08',
};

const SOURCE: ManifestEntry = {
    id: 'lei-1',
    path: 'corpus/public/lei-1.txt',
    kind: 'source',
    license: 'public-domain-law',
    sourceUrl: 'https://example.invalid/lei-1',
    collectedAt: '2026-09-08',
};

function derivedEntry(id: string, path: string): ManifestEntry {
    return { id, path, kind: 'derived', derivedFrom: ['lei-1'], model: 'm', recordedAt: '2026-09-08', reportVersion: 'v', storeEmbeddingModel: 'e', storeChunking: RAW.storeChunking };
}

/** Builds a `bench/`-shaped tree in a temp dir, runs `checkTree` on it, and removes it. */
function withTree(files: Record<string, unknown>, run: (problems: string[]) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'fundamentum-manifest-'));
    try {
        for (const [path, content] of Object.entries(files)) {
            const full = join(root, path);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
        }
        run(checkTree(root));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

const WELL_FORMED = {
    'corpus/manifest.json': { entries: [SOURCE, derivedEntry('r1', 'fixtures/google/r1.json'), derivedEntry('labeled-r1', 'fixtures/labeled/r1.json')] },
    'corpus/public/lei-1.txt': 'Art. 1o Texto.',
    'corpus/public/LICENSE': 'the corpus license, not a document of the corpus',
    'fixtures/google/r1.json': RAW,
    'fixtures/labeled/r1.json': LABEL,
};

describe('the walk and the rules, on a temporary tree', () => {
    it('a well-formed tree has no problems: the LICENSE is not a document, and paths found by the OS match paths declared with slashes', () => {
        withTree(WELL_FORMED, (problems) => expect(problems).toEqual([]));
    });

    it('toManifestPath produces the manifest form from a Windows walk and from a POSIX walk, on any host', () => {
        // Each platform's `relative` is passed explicitly: the CI host is Linux,
        // where the default `relative` would read a backslash as an ordinary character.
        expect(toManifestPath('C:\\bench', 'C:\\bench\\corpus\\public\\lei-1.txt', win32.relative)).toBe('corpus/public/lei-1.txt');
        expect(toManifestPath('/bench', '/bench/corpus/public/lei-1.txt', posix.relative)).toBe('corpus/public/lei-1.txt');
    });

    it('a file with no entry is named, wherever it is under a governed directory', () => {
        withTree({ ...WELL_FORMED, 'corpus/public/stray.txt': 'x' }, (problems) => {
            expect(problems).toEqual(['file "corpus/public/stray.txt" has no manifest entry']);
        });
    });

    it('a label filed under an id without the prefix is refused, not skipped', () => {
        const manifest = { entries: [SOURCE, derivedEntry('r1', 'fixtures/google/r1.json'), derivedEntry('r1-label', 'fixtures/labeled/r1.json')] };
        withTree({ ...WELL_FORMED, 'corpus/manifest.json': manifest }, (problems) => {
            expect(problems).toEqual(['label file "fixtures/labeled/r1.json" is filed under id "r1-label", which is not a derived "labeled-<id>" entry']);
        });
    });

    it('a label filed against a source entry is named by the manifest rules, not crashed on', () => {
        // `labeled-lei-1` names the corpus document as its response; the raw side must not try to parse a .txt as JSON.
        const manifest = { entries: [SOURCE, derivedEntry('labeled-lei-1', 'fixtures/labeled/r1.json')] };
        withTree({ 'corpus/manifest.json': manifest, 'corpus/public/lei-1.txt': 'Art. 1o Texto.', 'fixtures/labeled/r1.json': LABEL }, (problems) => {
            expect(problems).toEqual(['label "labeled-lei-1" and response "lei-1" disagree on derivedFrom']);
        });
    });

    it('a label whose response file is absent is named by the manifest rules, not crashed on', () => {
        const { 'fixtures/google/r1.json': _absent, ...withoutResponse } = WELL_FORMED;
        withTree(withoutResponse, (problems) => {
            expect(problems).toEqual(['entry "r1" points at "fixtures/google/r1.json", which does not exist']);
        });
    });

    it('a recorded response whose own id differs from the id it is filed under is named', () => {
        withTree({ ...WELL_FORMED, 'fixtures/google/r1.json': { ...RAW, id: 'r9' } }, (problems) => {
            expect(problems).toEqual([
                'response file "fixtures/google/r1.json" says id "r9", but the manifest files it as "r1"',
                'label "r1" is filed against response "r9"',
            ]);
        });
    });

    it('a label filed under the prefix is opened: its signer, its spans and its parts are checked against the recorded response', () => {
        const drifted: LabeledFixture = { ...LABEL, labeledBy: 'someone', parts: [{ text: 'Frase um. Frase DOIS.' }] };
        withTree({ ...WELL_FORMED, 'fixtures/labeled/r1.json': drifted }, (problems) => {
            expect(problems).toEqual([
                'label "r1" is signed by "someone", who is not in the allowlist',
                'label "r1" carries parts that differ from the recorded response',
            ]);
        });
    });
});

/**
 * The NOTICE beside the corpus makes two claims about how the six normative
 * acts cite one another. They are the reason those six were chosen together
 * rather than any six public-domain files, so they are worth a guard: an edit
 * to any `.txt` could otherwise leave the published prose describing a corpus
 * that no longer exists, and nothing would say so.
 *
 * The graph itself is computed by `npm run bench:corpus`, from the files in
 * the repository. This test only holds the prose and the computation to each
 * other.
 */
describe('corpus - the citation graph the NOTICE describes', () => {
    // Line-wrapped prose: collapse the wrapping so a claim that spans two
    // lines still matches, and a reflow of the file does not fail the test.
    const NOTICE = readFileSync(join(REPO_BENCH, 'corpus/public/NOTICE'), 'utf8').replace(/\s+/gu, ' ');

    it('derives an act number from the file name, and refuses one too short to match', () => {
        expect(actNumber('lei-15100')).toBe('15.100');
        expect(actNumber('ldb-9394')).toBe('9.394');
        // "CNE/CEB n. 2": a bare `2` would match a digit in every article of
        // every file, so the resolution cites and is never cited.
        expect(actNumber('resolucao-cne-ceb-2')).toBeNull();
        expect(actNumber('machado-memorias-posthumas')).toBeNull();
    });

    it('the nine edges the NOTICE claims are the nine the corpus has', () => {
        const edges = citationGraph();
        expect(edges).toHaveLength(9);
        expect(NOTICE).toContain('nine directed edges');
    });

    it('the heaviest edge is the one the NOTICE names, with the count it names', () => {
        const heaviest = citationGraph()[0]!;
        expect(heaviest.from).toBe('decreto-12385');
        expect(heaviest.to).toBe('lei-15100');
        expect(heaviest.count).toBe(13);
        expect(NOTICE).toContain('decreto-12385 -> lei-15100, thirteen times');
    });

    it('the dot in an act number is a dot, not a wildcard', () => {
        // The pattern is built from the act number, so the dot has to be
        // escaped going in. It was not: `'\.'` in a JavaScript source file is
        // the one-character string `.`, which makes the replace a no-op and
        // the dot match any character. Nothing in the corpus of six happened
        // to collide, so every count stayed right and nothing failed - the
        // kind of bug that waits for the seventh document.
        const cited = { id: 'lei-15100', title: 'a', text: 'this one is cited' };
        const citing = {
            id: 'decreto-99999',
            title: 'b',
            text: 'regulates Lei 15.100, and mentions the string 15X100, which is not a citation',
        };
        expect(citationGraph([cited, citing])).toEqual([
            { from: 'decreto-99999', to: 'lei-15100', count: 1 },
        ]);
    });

    it('no act cites itself, and the margin is not mistaken for citation', () => {
        const edges = citationGraph();
        expect(edges.filter((e) => e.from === e.to)).toEqual([]);
        // `pne-13005` carries "(Vide Decreto no 11.713, de 2023)" in the
        // editorial margin of Meta 7. That is amendment history filed by the
        // publisher, not the PNE invoking the decree, and it must not appear.
        expect(edges.find((e) => e.from === 'pne-13005' && e.to === 'decreto-11713')).toBeUndefined();
    });
});
