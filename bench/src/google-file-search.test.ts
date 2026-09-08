import { describe, it, expect, vi, afterEach } from 'vitest';
import { createGoogleFileSearchClient } from './google-file-search.js';
import type { RunMeta } from './aggregate.js';

/**
 * The client talks to one service and the suite must not, so `fetch` is stubbed
 * and every call is recorded. What is pinned here is the one invariant whose
 * violation would be silent: a document that came back FAILED is DELETED before
 * the next upload. Without that delete the store ends up holding the corpus
 * twice under one display name — the attribution still resolves, because both
 * copies carry the same manifest id, but the corpus measured stops being the
 * corpus declared, and nothing in the pipeline says so.
 */

const CHUNKING: RunMeta['storeChunking'] = { maxTokensPerChunk: 200, maxOverlapTokens: 20 };
const STORE = 'fileSearchStores/store-under-test';
const instantly = async (): Promise<void> => {};

interface Call {
    readonly method: string;
    readonly url: string;
}

/**
 * Answers the client the way the API does, taking the document states from
 * `states`: one entry per upload, in order. An upload past the end of the list
 * keeps failing rather than answering an absent state — with an instant `sleep`
 * the poll's wall-clock deadline never arrives, so an absent state would spin
 * the client until the worker runs out of memory instead of failing an
 * assertion.
 */
function stubFetch(states: readonly ('STATE_ACTIVE' | 'STATE_FAILED')[]): Call[] {
    const calls: Call[] = [];
    let uploads = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        calls.push({ method, url });
        if (url.endsWith(':uploadToFileSearchStore')) {
            uploads++;
            return new Response(JSON.stringify({ name: 'op', response: { documentName: `${STORE}/documents/doc-${uploads}` } }), { status: 200 });
        }
        if (method === 'DELETE') return new Response('{}', { status: 200 });
        const nth = Number(url.split('doc-')[1]);
        return new Response(JSON.stringify({ name: url, state: states[nth - 1] ?? 'STATE_FAILED', sizeBytes: '374753' }), { status: 200 });
    });
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('importDocument — a FAILED document is deleted before the next upload', () => {
    it('deletes the failed document, with the force the API requires, and only then uploads again', async () => {
        const calls = stubFetch(['STATE_FAILED', 'STATE_ACTIVE']);
        await createGoogleFileSearchClient('test-key', instantly).importDocument(STORE, 'machado', 'Frase um.', CHUNKING);

        expect(calls.map((c) => `${c.method} ${c.url.replace('https://generativelanguage.googleapis.com', '')}`)).toEqual([
            'POST /upload/v1beta/fileSearchStores/store-under-test:uploadToFileSearchStore',
            'GET /v1beta/fileSearchStores/store-under-test/documents/doc-1',
            // Measured on 2026-09-08: without `force`, deleting a document with
            // content answers 400 "Cannot delete non-empty Document" and the
            // document stays — which is how the store would come to hold two.
            'DELETE /v1beta/fileSearchStores/store-under-test/documents/doc-1?force=true',
            'POST /upload/v1beta/fileSearchStores/store-under-test:uploadToFileSearchStore',
            'GET /v1beta/fileSearchStores/store-under-test/documents/doc-2',
        ]);
    });

    it('a document that indexes on the first upload is never deleted', async () => {
        const calls = stubFetch(['STATE_ACTIVE']);
        await createGoogleFileSearchClient('test-key', instantly).importDocument(STORE, 'machado', 'Frase um.', CHUNKING);
        expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
        expect(calls.filter((c) => c.url.endsWith(':uploadToFileSearchStore'))).toHaveLength(1);
    });

    it('a document that never indexes ends the round, and the error carries the only thing the resource says: the size', async () => {
        const calls = stubFetch(Array<'STATE_FAILED'>(5).fill('STATE_FAILED'));
        const client = createGoogleFileSearchClient('test-key', instantly);
        await expect(client.importDocument(STORE, 'machado', 'Frase um.', CHUNKING)).rejects.toThrow(
            'document machado (374753 bytes) came back FAILED on 5 uploads, with no reason on the resource',
        );
        // Every attempt cleaned up after itself: as many deletes as uploads.
        expect(calls.filter((c) => c.url.endsWith(':uploadToFileSearchStore'))).toHaveLength(5);
        expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(5);
    });

    it('the waits between re-uploads are the declared ones, one for each gap', async () => {
        // Written against the waits and not against the constants because the
        // gap is what drifts: raise the attempts without adding a wait and the
        // `??` fallback substitutes the poll interval silently, which this
        // list catches and a length assertion on the constant would not.
        stubFetch(Array<'STATE_FAILED'>(5).fill('STATE_FAILED'));
        const waits: number[] = [];
        const record = async (ms: number): Promise<void> => {
            waits.push(ms);
        };
        await expect(
            createGoogleFileSearchClient('test-key', record).importDocument(STORE, 'machado', 'Frase um.', CHUNKING),
        ).rejects.toThrow();
        expect(waits).toEqual([5000, 15000, 45000, 60000]);
    });

    it('the round hears about a retry: each failure and the upload that finally indexed', async () => {
        stubFetch(['STATE_FAILED', 'STATE_ACTIVE']);
        const lines: string[] = [];
        await createGoogleFileSearchClient('test-key', instantly, (l) => lines.push(l)).importDocument(STORE, 'machado', 'Frase um.', CHUNKING);
        expect(lines).toEqual([
            '  machado (374753 bytes) came back FAILED on upload 1 of 5, with no reason on the resource',
            '  machado indexed on upload 2 of 5',
        ]);
    });
});
