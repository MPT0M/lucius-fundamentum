/**
 * What the corpus is made of, measured from the repository.
 *
 * Every number this project publishes about its own corpus used to come from
 * a script that read three files by absolute path, two of which lived outside
 * the repository. The numbers were true and nobody else could check them,
 * which in a project whose argument is "we measure, and we show against what"
 * is the wrong kind of true.
 *
 * This reads `bench/corpus/public/` — whatever is in it — through
 * `new URL(..., import.meta.url)`, so it runs wherever the repository is
 * cloned, with no key, no network and no path from anyone's home directory.
 *
 *   npm run bench:corpus
 *
 * The three categories are the ones that separate a lexical arm from a dense
 * one. A dense retriever dissolves a composite number into a vector of
 * "number"; a lexical index treats it as an identifier. The literary text in
 * this directory has none of them, which is why the normative documents are
 * here.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chunk, DEFAULT_CHUNK_OPTIONS, type SourceDoc } from '../../src/chunker.js';
import { countCodePoints } from '../../src/unicode.js';
import { createTokenizer } from '../../src/tokenizer.js';
import { RSLP_S_FOLDED } from '../../src/stemmer.js';

/**
 * The compiled file lives at `bench/.out/bench/src/`, four levels under the
 * repository root, and the sources at `bench/src/`, two. Resolving from the
 * root rather than relative to this file makes the same path work from both,
 * which is how `bench/src/main.ts` already does it — a probe that only runs
 * from one of them is a probe that breaks the day someone runs it the other
 * way.
 */
const REPO_ROOT = fileURLToPath(
    new URL(import.meta.url.includes('/.out/') ? '../../../../' : '../../', import.meta.url),
);
const CORPUS_DIR = `${REPO_ROOT}bench/corpus/public/`;

/** Digits joined to digits by one of the five separators the tokenizer fuses. */
const COMPOSITE_NUMBER = /\d+(?:[.,/:-]\d+)+/gu;
/** A reference to an article, paragraph or item, with its number. */
const PROVISION = /\b(?:art|arts|inc|par)\.?\s*\d+[º°]?/giu;
/**
 * Editorial margin of a consolidated text: `(Redação dada pela Lei nº X)` and
 * its siblings. Removed before counting, because those notes carry law numbers
 * that belong to the amendment history and not to the law. Measured on the
 * LDB, 362 of its 381 composite numbers are in the margin — counting them
 * would report retrieval of edit history as retrieval of legislation.
 */
const EDITORIAL_MARGIN =
    /\((?:Revogad|Incluíd|Redação dada|Vide|Vigência|Renumerad|Regulamento)[^)]*\)/giu;

/**
 * The number an act is known by, derived from the file name so that adding a
 * document to the directory adds it to the graph with no table to update:
 * `lei-15100` -> `15.100`, `ldb-9394` -> `9.394`.
 *
 * Returns null below four digits. `resolucao-cne-ceb-2` is a resolution known
 * as "CNE/CEB n. 2", and a bare `2` would match a digit in every article of
 * every file. A document with no matchable number can still cite others; it
 * simply cannot be cited, which is what the graph then reports.
 */
export function actNumber(documentId: string): string | null {
    const digits = /(\d{4,6})$/u.exec(documentId)?.[1];
    if (digits === undefined) return null;
    return `${digits.slice(0, -3)}.${digits.slice(-3)}`;
}

export interface CitationEdge {
    readonly from: string;
    readonly to: string;
    readonly count: number;
}

/**
 * Which act cites which, counted on the body alone.
 *
 * The editorial margin is removed first for the reason it always is: a note
 * reading "(Vide Decreto n. 11.713)" is amendment history attached by the
 * publisher, not one act invoking another. Counting it would turn the LDB
 * into a citer of every law that ever amended it.
 *
 * This exists because the NOTICE in the corpus directory makes a claim about
 * the shape of this graph, and a claim about the corpus that only the author
 * can check is the wrong kind of true - the same standard this file opens by
 * applying to every other number here.
 */
export function citationGraph(docs: readonly SourceDoc[] = readCorpus()): CitationEdge[] {
    const numbers = new Map(docs.map((d) => [d.id, actNumber(d.id)]));
    const edges: CitationEdge[] = [];

    for (const source of docs) {
        const body = source.text.replace(EDITORIAL_MARGIN, '');
        for (const target of docs) {
            const number = numbers.get(target.id);
            if (target.id === source.id || number === null || number === undefined) continue;
            const count = count_(body, new RegExp(number.replace('.', '\\.'), 'gu'));
            if (count > 0) edges.push({ from: source.id, to: target.id, count });
        }
    }

    return edges.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
}

export interface DocumentProfile {
    readonly id: string;
    readonly codePoints: number;
    /** Code points with the editorial margin removed. */
    readonly bodyCodePoints: number;
    readonly chunks: number;
    readonly overlaps: number;
    /** Chunks over `maxChunkCodePoints`: a single sentence longer than the ceiling. */
    readonly oversizedChunks: number;
    /** Chunks whose span is contained in the previous one. Must be zero. */
    readonly redundantChunks: number;
    readonly compositeNumbers: number;
    readonly provisions: number;
    readonly tokens: number;
}

const count_ = (text: string, re: RegExp) => (text.match(re) ?? []).length;

export function profileDocument(doc: SourceDoc): DocumentProfile {
    const body = doc.text.replace(EDITORIAL_MARGIN, '');
    const pieces = chunk(doc, DEFAULT_CHUNK_OPTIONS);
    const tokenizer = createTokenizer({ stemmer: RSLP_S_FOLDED });

    let redundant = 0;
    for (let i = 1; i < pieces.length; i += 1) {
        const previous = pieces[i - 1]!;
        const current = pieces[i]!;
        if (current.span.start >= previous.span.start && current.span.end <= previous.span.end) redundant += 1;
    }

    return {
        id: doc.id,
        codePoints: countCodePoints(doc.text),
        bodyCodePoints: countCodePoints(body),
        chunks: pieces.length,
        overlaps: Math.max(0, pieces.length - 1),
        oversizedChunks: pieces.filter((p) => countCodePoints(p.text) > DEFAULT_CHUNK_OPTIONS.maxChunkCodePoints)
            .length,
        redundantChunks: redundant,
        compositeNumbers: count_(body, COMPOSITE_NUMBER),
        provisions: count_(body, PROVISION),
        tokens: pieces.reduce((sum, p) => sum + tokenizer.tokenize(p.text).length, 0),
    };
}

/** Every `.txt` under `bench/corpus/public/`, in directory order. */
export function readCorpus(): SourceDoc[] {
    return readdirSync(CORPUS_DIR)
        .filter((name) => name.endsWith('.txt'))
        .sort()
        .map((name) => ({
            id: name.replace(/\.txt$/, ''),
            title: name.replace(/\.txt$/, ''),
            text: readFileSync(CORPUS_DIR + name, 'utf8'),
        }));
}

export function profileCorpus(): DocumentProfile[] {
    return readCorpus().map(profileDocument);
}

function main(): void {
    const profiles = profileCorpus();
    const pad = (s: string | number, n: number) => String(s).padStart(n);

    console.log('| document | code points | body | chunks | oversized | redundant | composite | provisions | tokens |');
    console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const p of profiles) {
        console.log(
            `| ${p.id} | ${pad(p.codePoints, 7)} | ${pad(p.bodyCodePoints, 7)} | ${pad(p.chunks, 4)} | ` +
                `${pad(p.oversizedChunks, 3)} | ${pad(p.redundantChunks, 3)} | ${pad(p.compositeNumbers, 4)} | ` +
                `${pad(p.provisions, 4)} | ${pad(p.tokens, 6)} |`,
        );
    }

    const total = (pick: (p: DocumentProfile) => number) => profiles.reduce((s, p) => s + pick(p), 0);
    console.log();
    console.log(`documents ${profiles.length}`);
    console.log(`chunks ${total((p) => p.chunks)}, of which ${total((p) => p.oversizedChunks)} oversized`);
    console.log(`overlaps ${total((p) => p.overlaps)}`);
    console.log(`redundant chunks ${total((p) => p.redundantChunks)} (the guard in the chunker keeps this at zero)`);
    console.log(`tokens ${total((p) => p.tokens)}`);

    const edges = citationGraph();
    console.log();
    console.log(`cross-document citation: ${edges.length} directed edges (editorial margin removed)`);
    for (const e of edges) console.log(`  ${e.from} -> ${e.to} ${pad(e.count, 4)}`);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
    main();
}
