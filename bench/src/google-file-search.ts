/**
 * The emitter behind the key: Google's File Search, over the REST surface the
 * documentation fixes (v1beta, 2026). This is the only file of the harness
 * that knows a wire shape, and it decides nothing about the measurement: it
 * creates a store, imports documents, asks a question and returns what came
 * back, untouched, for `run.ts` to record.
 *
 * Three facts of the wire the round depends on, each checked against the
 * official reference and then against the live API on 2026-09-08:
 *   - a store is created with `displayName` and `embeddingModel` (the model id
 *     with the `models/` prefix);
 *   - an upload's JSON metadata carries `displayName`, `customMetadata`
 *     (`[{ key, stringValue }]`) and `chunkingConfig.whiteSpaceConfig`
 *     (`maxTokensPerChunk`, `maxOverlapTokens`); the response names the
 *     document at once, and the document's `state` says when it is indexed;
 *   - the grounding a response returns carries, per chunk, `retrievedContext`
 *     with `title` (the display name) and `customMetadata`, and the tool's
 *     tokens are `usageMetadata.toolUsePromptTokenCount`.
 *
 * We upload `displayName = documentId` and `customMetadata = [{ key:
 * 'documentId', stringValue: documentId }]` — both equal to the manifest key —
 * so that `resolveOrigin` matches either hint by identity. The upload uses the
 * multipart protocol the production client already exercises against this
 * API, with the two new fields added to its metadata part.
 *
 * Retries: only what is safe to repeat. A `GET`, a `generateContent` and a
 * `DELETE` can be repeated without a second effect, so a transient status
 * (measured: a 503 "Deadline expired" mid-round) is retried with growing
 * delays — a delete that is never retried would leave a live store billing
 * for a moment of overload. Creating a store and uploading a document are not
 * retried: a retry after the server had already accepted the request would
 * leave an orphan store or a duplicate document, and the round would rather
 * fail loudly.
 *
 * The key travels in the `x-goog-api-key` header, never in the URL.
 */

import type { RunMeta } from './aggregate.js';
import type { FileSearchClient, RawResponse } from './run.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/';
const UPLOAD_API = 'https://generativelanguage.googleapis.com/upload/v1beta/';
const POLL_INTERVAL_MS = 5000;
/** A 370k-character book took longer than five minutes to index in the first run; the ceiling is generous on purpose. */
const POLL_TIMEOUT_MS = 20 * 60 * 1000;
/** Statuses the API returns for a moment of overload, not for a wrong request. */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [5000, 15000, 45000];

/**
 * What the multipart upload returns. Measured on 2026-09-08: the body carries
 * `response.documentName` immediately and no `done` field — the document
 * exists but is still being indexed — while `GET` on the operation reports
 * `done: true` only when indexing is over. The document's own `state` is the
 * signal the round waits for.
 */
interface UploadOperation {
    readonly name: string;
    readonly response?: { readonly documentName?: string };
    readonly error?: { readonly code: number; readonly message: string };
}

interface FileSearchDocument {
    readonly name: string;
    readonly state?: 'STATE_UNSPECIFIED' | 'STATE_PENDING' | 'STATE_ACTIVE' | 'STATE_FAILED';
}

interface GenerateResponse {
    readonly candidates?: readonly {
        readonly content?: { readonly parts?: readonly { readonly text?: string }[] };
        readonly groundingMetadata?: RawResponse['groundingMetadata'];
    }[];
    readonly usageMetadata?: RawResponse['usageMetadata'];
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(apiKey: string, url: string, init: RequestInit): Promise<Response> {
    return fetch(url, { ...init, headers: { ...(init.headers ?? {}), 'x-goog-api-key': apiKey } });
}

async function failure(method: string, url: string, response: Response, attempts: number): Promise<Error> {
    return new Error(`${method} ${url} failed (${response.status}) after ${attempts} attempt(s): ${await response.text()}`);
}

/** One request, no retry: for calls whose repetition would have a side effect. */
async function requestOnce<T>(apiKey: string, url: string, init: RequestInit): Promise<T> {
    const response = await send(apiKey, url, init);
    if (!response.ok) throw await failure(init.method ?? 'GET', url, response, 1);
    return (await response.json()) as T;
}

/** A request retried on transient statuses, returning the raw response: only for calls safe to repeat. */
async function sendRetrying(apiKey: string, url: string, init: RequestInit, sleep: Sleep): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
        const response = await send(apiKey, url, init);
        if (response.ok) return response;
        const delay = RETRY_DELAYS_MS[attempt];
        if (!TRANSIENT_STATUSES.has(response.status) || delay === undefined) {
            throw await failure(init.method ?? 'GET', url, response, attempt + 1);
        }
        await sleep(delay);
    }
}

async function requestRetrying<T>(apiKey: string, url: string, init: RequestInit, sleep: Sleep): Promise<T> {
    return (await (await sendRetrying(apiKey, url, init, sleep)).json()) as T;
}

export function createGoogleFileSearchClient(apiKey: string, sleep: Sleep = defaultSleep): FileSearchClient {
    async function waitForDocument(documentName: string): Promise<void> {
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        for (;;) {
            const doc = await requestRetrying<FileSearchDocument>(apiKey, API + documentName, { method: 'GET' }, sleep);
            if (doc.state === 'STATE_ACTIVE') return;
            if (doc.state === 'STATE_FAILED') throw new Error(`document ${documentName} failed to index`);
            if (Date.now() > deadline) throw new Error(`document ${documentName} was not active within ${POLL_TIMEOUT_MS} ms (state ${doc.state ?? 'absent'})`);
            await sleep(POLL_INTERVAL_MS);
        }
    }

    return {
        async createStore(embeddingModel: string) {
            const store = await requestOnce<{ name: string }>(apiKey, `${API}fileSearchStores`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ displayName: `fundamentum-bench-${Date.now()}`, embeddingModel: `models/${embeddingModel}` }),
            });
            return { storeName: store.name };
        },

        async importDocument(storeName: string, documentId: string, text: string, chunking: RunMeta['storeChunking']) {
            const metadata = JSON.stringify({
                displayName: documentId,
                customMetadata: [{ key: 'documentId', stringValue: documentId }],
                chunkingConfig: {
                    whiteSpaceConfig: { maxTokensPerChunk: chunking.maxTokensPerChunk, maxOverlapTokens: chunking.maxOverlapTokens },
                },
            });
            const boundary = `----fundamentum${Math.random().toString(36).slice(2)}`;
            const body =
                `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
                `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
            const operation = await requestOnce<UploadOperation>(apiKey, `${UPLOAD_API}${storeName}:uploadToFileSearchStore`, {
                method: 'POST',
                headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'X-Goog-Upload-Protocol': 'multipart' },
                body,
            });
            if (operation.error !== undefined) throw new Error(`upload of ${documentId} failed: ${operation.error.message}`);
            const documentName = operation.response?.documentName;
            if (documentName === undefined) throw new Error(`upload of ${documentId} returned no documentName`);
            await waitForDocument(documentName);
        },

        async generate(storeName: string, model: string, question: string, systemInstruction: string | null): Promise<RawResponse> {
            const data = await requestRetrying<GenerateResponse>(apiKey, `${API}models/${model}:generateContent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...(systemInstruction === null ? {} : { systemInstruction: { parts: [{ text: systemInstruction }] } }),
                    contents: [{ role: 'user', parts: [{ text: question }] }],
                    tools: [{ fileSearch: { fileSearchStoreNames: [storeName] } }],
                }),
            }, sleep);
            const candidate = data.candidates?.[0];
            return {
                parts: (candidate?.content?.parts ?? []).map((p) => ({ text: p.text ?? '' })),
                usageMetadata: data.usageMetadata ?? {},
                ...(candidate?.groundingMetadata === undefined ? {} : { groundingMetadata: candidate.groundingMetadata }),
            };
        },

        async deleteStore(storeName: string) {
            // The body of a DELETE is not read: it may be empty, and the status is the answer.
            await sendRetrying(apiKey, `${API}${storeName}?force=true`, { method: 'DELETE' }, sleep);
        },
    };
}
