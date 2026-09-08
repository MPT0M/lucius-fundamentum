import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRound, type FileSearchClient, type RawResponse, type Variant } from './run.js';
import type { RunMeta } from './aggregate.js';
import type { GoogleRawFixture } from './fixture.js';

/**
 * The runner is network and disk, and the plan keeps it out of the suite for
 * that reason. These two cases need neither: the client is injected, and the
 * two roots are temporary directories. They pin the parts that are decisions
 * rather than plumbing — that a store is deleted even when the import that
 * follows it fails, and that a round with nothing to ask never creates one.
 */

const META: RunMeta = {
    model: 'test-model',
    recordedAt: '2026-09-08T16:00:00.000Z',
    reportVersion: 'test',
    storeEmbeddingModel: 'test-embedding',
    storeChunking: { maxTokensPerChunk: 200, maxOverlapTokens: 20 },
    providerId: null,
    formatVersion: null,
};

const VARIANTS: readonly Variant[] = [{ name: 'plain', systemInstruction: null }];

const ANSWER: RawResponse = {
    parts: [{ text: 'Frase um.' }],
    usageMetadata: { toolUsePromptTokenCount: 1 },
};

/** A `bench/` tree with one source document and one question. */
function benchRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'fundamentum-run-bench-'));
    const write = (path: string, content: unknown): void => {
        const full = join(root, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
    };
    write('corpus/public/doc.txt', 'Frase um. Frase dois.');
    write('corpus/manifest.json', {
        entries: [{ id: 'doc', path: 'corpus/public/doc.txt', kind: 'source', license: 'public-domain-law', sourceUrl: 'https://example.invalid/doc', collectedAt: '2026-09-08' }],
    });
    write('corpus/questions.json', { questions: [{ id: 'q01', derivedFrom: ['doc'], question: 'Uma pergunta?' }] });
    return root;
}

/** Records what the runner asked of the emitter, so a test can assert on the calls. */
function spyClient(over: Partial<FileSearchClient> = {}): FileSearchClient & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        async createStore() {
            calls.push('createStore');
            return { storeName: 'fileSearchStores/store-under-test' };
        },
        async importDocument(_store, documentId) {
            calls.push(`importDocument:${documentId}`);
        },
        async generate() {
            calls.push('generate');
            return ANSWER;
        },
        async deleteStore(storeName) {
            calls.push(`deleteStore:${storeName}`);
        },
        ...over,
    };
}

function withRoots(run: (benchDir: string, outDir: string) => Promise<void>): Promise<void> {
    const benchDir = benchRoot();
    const outDir = mkdtempSync(join(tmpdir(), 'fundamentum-run-out-'));
    return run(benchDir, outDir).finally(() => {
        rmSync(benchDir, { recursive: true, force: true });
        rmSync(outDir, { recursive: true, force: true });
    });
}

describe('runRound — a store belongs to the round that created it', () => {
    it('an import that fails deletes the store it was importing into', async () => {
        // Measured on 2026-09-08: a document came back FAILED to index, the round
        // died at the import, and the store stayed alive because creation and
        // import sat outside the try whose finally deletes it.
        const lines: string[] = [];
        const client = spyClient({
            async importDocument() {
                throw new Error('document came back FAILED');
            },
        });
        await withRoots(async (benchDir, outDir) => {
            await expect(
                runRound({ benchRoot: benchDir, outRoot: outDir, client, meta: META, variants: VARIANTS, log: (l) => lines.push(l) }),
            ).rejects.toThrow('document came back FAILED');
            expect(client.calls).toEqual(['createStore', 'deleteStore:fileSearchStores/store-under-test']);
            expect(lines).toContain('deleted fileSearchStores/store-under-test');
        });
    });

    it('a round that reuses every recorded answer creates no store', async () => {
        const client = spyClient({
            async createStore() {
                throw new Error('a round with nothing to ask must not reach the emitter');
            },
        });
        await withRoots(async (benchDir, outDir) => {
            const fixture: GoogleRawFixture = {
                id: 'q01-plain',
                model: META.model,
                recordedAt: META.recordedAt,
                reportVersion: META.reportVersion,
                storeEmbeddingModel: META.storeEmbeddingModel,
                storeChunking: META.storeChunking,
                parts: [{ text: 'Frase um.' }],
                usageMetadata: {},
            };
            const path = join(outDir, 'fixtures', 'google', 'q01-plain.json');
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, JSON.stringify(fixture), 'utf8');

            const outcome = await runRound({ benchRoot: benchDir, outRoot: outDir, client, meta: META, variants: VARIANTS, log: () => {} });
            expect(outcome.reused).toEqual(['q01-plain']);
            expect(outcome.recorded).toEqual([]);
            expect(client.calls).toEqual([]);
        });
    });
});
