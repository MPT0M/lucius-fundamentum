/**
 * The round, fired by hand: network and file writing, and nothing else.
 *
 * Every rule of the ruler lives in a pure module with its own test — utf8,
 * locate, score, parse, aggregate, manifest, label-check. This file only wires
 * them to the emitter behind a key and to the disk. No predicate and no count
 * that reaches a report is decided here. If a number in a report cannot be
 * traced to one of those modules, it is a bug here. The suite does reach this
 * file — `run.test.ts` gives it a fake client and temporary directories — but
 * never the key and never the network.
 *
 * What a round does, in order:
 *   1. reads the manifest and the question set from the public `bench/`, and
 *      builds the round corpus — every source document masked once;
 *   2. for every question and every variant — with and without the system
 *      instruction that tells the model to search — either REUSES the answer
 *      already recorded under the private output root, or asks the emitter
 *      and records the raw answer exactly as it came plus the round's
 *      identification. A recorded answer is the fixture: the label is written
 *      over its text, so it is never re-asked in place, and a round that has
 *      nothing to ask creates no store and touches no network. Growing the
 *      question set keeps the same root: the answers already there are reused,
 *      and the report's header covers both sessions. Replacing what is being
 *      measured — another model, another corpus — takes a new root, because
 *      those answers are not comparable with these;
 *   3. checks every hand-written label found beside a recorded answer against
 *      the scorer's assumptions and against the answer it claims to
 *      transcribe. One refused label refuses the whole round, with every
 *      problem of every label named at once: a wrong label is a broken
 *      instrument, not missing work, and a report with fewer answers and no
 *      field saying why would read as either;
 *   4. parses, scores and aggregates per variant, one report per variant,
 *      written privately and, since a report carries counts and never text,
 *      publicly under `bench/reports/`. The report's `recordedAt` comes from
 *      the aggregated answers — the instant they share, or the interval that
 *      covers them — never from the clock of the run that reused them.
 *
 * The raw answers stay outside the repository: the owner decided that the
 * emitter's generated text does not enter the public tree, only the numbers.
 * A consequence: a recorded answer has no manifest entry, so `derivedFrom` —
 * which the plan read from the manifest — comes from the question set
 * (`bench/corpus/questions.json`), and `viewOf` still refuses an id the round
 * corpus does not have.
 *
 * Files are written as `JSON.stringify(data, null, 2) + '\n'` with LF, so a
 * fixture is born right on any OS and its diff stays stable.
 *
 * The two variants exist because a corpus of famous books invites a model to
 * answer from memory and never search, and then there is no citation to
 * measure. The `guided` variant carries a short instruction to search; the
 * `plain` variant carries none. Activation is measured in both.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { maskProtectedRegions } from '../../src/mask.js';
import { aggregateRun, recordedAtOf, toolUsePromptTokens, type BenchmarkRunReport, type RunMeta } from './aggregate.js';
import { ALLOWED_LABELERS } from './allowlists.js';
import type { MaskedCorpus, MaskedDocument } from './corpus.js';
import type { GoogleRawFixture } from './fixture.js';
import { checkLabel } from './label-check.js';
import type { Manifest, SourceEntry } from './manifest.js';
import { parseResponse } from './parse.js';
import { scoreResponse, type LabeledFixture } from './score.js';

/** One question the round asks, over the documents it names. Its id, with the variant, becomes the fixture's id. */
export interface Question {
    readonly id: string;
    readonly derivedFrom: readonly string[];
    readonly question: string;
}

/** A way of asking: the same questions, with or without a system instruction. */
export interface Variant {
    readonly name: string;
    readonly systemInstruction: string | null;
}

/** What the emitter returned for one question, before any interpretation. */
export interface RawResponse {
    readonly parts: readonly { readonly text: string }[];
    readonly usageMetadata: GoogleRawFixture['usageMetadata'];
    readonly groundingMetadata?: GoogleRawFixture['groundingMetadata'];
}

/** The emitter behind a key. Implemented against the live API in `google-file-search.ts`. */
export interface FileSearchClient {
    createStore(embeddingModel: string): Promise<{ readonly storeName: string }>;
    importDocument(storeName: string, documentId: string, text: string, chunking: RunMeta['storeChunking']): Promise<void>;
    generate(storeName: string, model: string, question: string, systemInstruction: string | null): Promise<RawResponse>;
    deleteStore(storeName: string): Promise<void>;
}

export interface RunOptions {
    /** The public `bench/` directory: manifest, corpus, questions, and where public reports go. */
    readonly benchRoot: string;
    /** The private root: raw answers, labels, and the private copy of each report. */
    readonly outRoot: string;
    readonly client: FileSearchClient;
    readonly meta: RunMeta;
    readonly variants: readonly Variant[];
    readonly log: (line: string) => void;
}

export interface RoundOutcome {
    readonly recorded: readonly string[];
    readonly reused: readonly string[];
    readonly reports: Readonly<Record<string, BenchmarkRunReport>>;
}

interface Labeled {
    readonly question: Question;
    readonly fixture: GoogleRawFixture;
    readonly labeled: LabeledFixture;
}

function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, data: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8' });
}

/** Every source document of the manifest, masked once. */
function buildRoundCorpus(benchRoot: string, manifest: Manifest): MaskedCorpus {
    const round = new Map<string, MaskedDocument>();
    for (const entry of manifest.entries) {
        if (entry.kind !== 'source') continue;
        const text = readFileSync(join(benchRoot, entry.path), 'utf8');
        round.set(entry.id, { text, regions: maskProtectedRegions(text).spans });
    }
    return round;
}

const fixtureId = (question: Question, variant: Variant): string => `${question.id}-${variant.name}`;

export async function runRound(options: RunOptions): Promise<RoundOutcome> {
    const { benchRoot, outRoot, client, meta, variants, log } = options;
    const manifest = readJson<Manifest>(join(benchRoot, 'corpus', 'manifest.json'));
    const { questions } = readJson<{ readonly questions: readonly Question[] }>(join(benchRoot, 'corpus', 'questions.json'));
    const sources = manifest.entries.filter((e): e is SourceEntry => e.kind === 'source');
    const round = buildRoundCorpus(benchRoot, manifest);
    const fixturePath = (id: string): string => join(outRoot, 'fixtures', 'google', `${id}.json`);

    const recorded: string[] = [];
    const reused: string[] = [];
    const labeledByVariant = new Map<string, Labeled[]>();

    // The store is created only if some answer is missing: a round that reuses
    // every recorded answer never touches the network.
    const missing = variants.flatMap((v) => questions.map((q) => fixtureId(q, v))).filter((id) => !existsSync(fixturePath(id)));
    let storeName: string | null = null;

    // Creation and import live INSIDE the try: an import that fails — measured
    // on 2026-09-08, a document that came back FAILED to index — would
    // otherwise leave the store just created alive and billing, with nothing
    // to delete it.
    try {
        if (missing.length > 0) {
            storeName = (await client.createStore(meta.storeEmbeddingModel)).storeName;
            log(`store ${storeName}`);
            for (const source of sources) {
                await client.importDocument(storeName, source.id, round.get(source.id)!.text, meta.storeChunking);
                log(`imported ${source.id}`);
            }
        }

        for (const variant of variants) {
            const labeledHere: Labeled[] = [];
            for (const question of questions) {
                const id = fixtureId(question, variant);
                let fixture: GoogleRawFixture;
                if (existsSync(fixturePath(id))) {
                    fixture = readJson<GoogleRawFixture>(fixturePath(id));
                    reused.push(id);
                    log(`reusing recorded ${id}`);
                } else {
                    const response = await client.generate(storeName!, meta.model, question.question, variant.systemInstruction);
                    fixture = {
                        id,
                        model: meta.model,
                        recordedAt: meta.recordedAt,
                        reportVersion: meta.reportVersion,
                        storeEmbeddingModel: meta.storeEmbeddingModel,
                        storeChunking: meta.storeChunking,
                        parts: response.parts,
                        usageMetadata: response.usageMetadata,
                        ...(response.groundingMetadata === undefined ? {} : { groundingMetadata: response.groundingMetadata }),
                    };
                    writeJson(fixturePath(id), fixture);
                    recorded.push(id);
                    log(`recorded ${id}: searched=${toolUsePromptTokens(fixture) > 0} supports=${fixture.groundingMetadata?.groundingSupports?.length ?? 0}`);
                }
                const labelPath = join(outRoot, 'fixtures', 'labeled', `${id}.json`);
                if (existsSync(labelPath)) labeledHere.push({ question, fixture, labeled: readJson<LabeledFixture>(labelPath) });
            }
            labeledByVariant.set(variant.name, labeledHere);
        }
    } finally {
        if (storeName !== null) {
            // A failed delete must not hide the round's own error: it is logged with
            // the store's name, so the cleanup can be done by hand, and not thrown.
            try {
                await client.deleteStore(storeName);
                log(`deleted ${storeName}`);
            } catch (error) {
                log(`could not delete ${storeName}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    // Every label of every variant is checked before any report is written, and
    // every problem is named at once: a refused label is a broken instrument.
    const problems: string[] = [];
    for (const [variant, entries] of labeledByVariant) {
        for (const { question, fixture, labeled } of entries) {
            for (const problem of checkLabel(labeled, fixture, question.derivedFrom, ALLOWED_LABELERS)) {
                problems.push(`${variant}/${fixture.id}: ${problem}`);
            }
        }
    }
    if (problems.length > 0) {
        throw new Error(`the round is refused; fix the labels and run again:\n  ${problems.join('\n  ')}`);
    }

    const reports: Record<string, BenchmarkRunReport> = {};
    for (const [variant, entries] of labeledByVariant) {
        if (entries.length === 0) {
            log(`${variant}: no label yet — no report`);
            continue;
        }
        const parsed = entries.map((e) => parseResponse(e.fixture, round, e.question.derivedFrom));
        const scored = entries.map((e, i) => scoreResponse(e.labeled, parsed[i]!.candidates, round));
        const fixtures = entries.map((e) => e.fixture);
        // The header is derived from the very answers the aggregator then
        // checks, so its date cannot fail that check here: the check is for a
        // caller that brings its own `meta`. The clock of this run is not the
        // header — it dates the answers recorded now, and nothing else.
        const report = aggregateRun(scored, parsed, fixtures, { ...meta, recordedAt: recordedAtOf(fixtures) });
        // The interval's separator is not a file name: `/` joins the two ends of
        // the date. The count of answers joins the name because two rounds can
        // share both ends and cover different sets; reprocessing the same set is
        // meant to overwrite, and a different set should not.
        const name = `${report.recordedAt.replace(/[:./]/g, '-')}-${variant}-${fixtures.length}.json`;
        writeJson(join(outRoot, 'reports', name), report);
        writeJson(join(benchRoot, 'reports', name), report);
        reports[variant] = report;
        log(`${variant}: report over ${entries.length} labeled answers`);
    }
    return { recorded, reused, reports };
}
