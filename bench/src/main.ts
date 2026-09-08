/**
 * Command-line entry of the harness. Reads the key and the private output
 * root, fixes the round's identification, and fires `runRound`.
 *
 *   node bench/.out/bench/src/main.js --out <private-root> [--key-file <path>]
 *
 * The key comes from the file named by `--key-file` (a `KEY=value` file such
 * as a `.dev.vars`) when given, otherwise from `TEST_KEY` in the environment:
 * an explicit argument beats the ambient one. It is a test key, never
 * production's, and it never touches the repository.
 *
 * `--out` must resolve OUTSIDE the repository. The owner decided that the
 * emitter's raw answers do not enter the public tree; a root inside it would
 * put them one `git add` away, so it is refused.
 *
 * The system instruction of the `guided` variant is spike prose, written for
 * this harness alone and naming no author, so that a second document in the
 * corpus is asked under the same words; production prompts are the owner's
 * and live elsewhere.
 */

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunMeta } from './aggregate.js';
import { createGoogleFileSearchClient } from './google-file-search.js';
import { runRound, type Variant } from './run.js';

/** Version of this harness's report format; changes when `BenchmarkRunReport` changes shape. */
const REPORT_VERSION = 'bench-report-1';
const MODEL = 'gemini-3.5-flash-lite';
const STORE_EMBEDDING_MODEL = 'gemini-embedding-2';
/** Arbitrary and declared, like the thresholds: the values the API reference uses as its example. */
const STORE_CHUNKING = { maxTokensPerChunk: 200, maxOverlapTokens: 20 } as const;

const GUIDED_INSTRUCTION = [
    'You answer questions about the documents available through the file search tool.',
    'Whenever the question concerns the loaded documents, search them before answering,',
    'and base the answer on what the search returned rather than on memory.',
    'Cite the passages that support each statement.',
    'Answer in Portuguese.',
].join(' ');

const VARIANTS: readonly Variant[] = [
    { name: 'plain', systemInstruction: null },
    { name: 'guided', systemInstruction: GUIDED_INSTRUCTION },
];

function argValue(flag: string): string | undefined {
    const index = process.argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = process.argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
}

function readKey(keyFile: string | undefined): string {
    if (keyFile !== undefined) {
        const line = readFileSync(keyFile, 'utf8').split(/\r?\n/).find((l) => l.startsWith('TEST_KEY='));
        if (line === undefined) throw new Error(`no TEST_KEY= line in ${keyFile}`);
        return line.slice('TEST_KEY='.length).trim().replace(/^["']|["']$/g, '');
    }
    if (process.env.TEST_KEY) return process.env.TEST_KEY;
    throw new Error('no key: pass --key-file <path> or set TEST_KEY');
}

/** The private root must not be inside the repository: that is the whole point of it. */
function privateRoot(out: string | undefined, repoRoot: string): string {
    if (out === undefined) throw new Error('--out <private-root> is required: raw answers do not enter the repository');
    const absolute = resolve(out);
    const inside = relative(repoRoot, absolute);
    if (inside === '' || (!inside.startsWith('..') && !/^[A-Za-z]:/.test(inside))) {
        throw new Error(`--out ${absolute} is inside the repository; the raw answers must stay outside it`);
    }
    return absolute;
}

async function main(): Promise<void> {
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const outRoot = privateRoot(argValue('--out'), repoRoot);
    const apiKey = readKey(argValue('--key-file'));
    const meta: RunMeta = {
        model: MODEL,
        recordedAt: new Date().toISOString(),
        reportVersion: REPORT_VERSION,
        storeEmbeddingModel: STORE_EMBEDDING_MODEL,
        storeChunking: STORE_CHUNKING,
        providerId: null,
        formatVersion: null,
    };
    const log = (line: string): void => console.log(line);
    const outcome = await runRound({
        benchRoot: fileURLToPath(new URL('../../../../bench/', import.meta.url)),
        outRoot,
        client: createGoogleFileSearchClient(apiKey, undefined, log),
        meta,
        variants: VARIANTS,
        log,
    });
    console.log(`recorded ${outcome.recorded.length}, reused ${outcome.reused.length}; reports: ${Object.keys(outcome.reports).join(', ') || 'none'}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
