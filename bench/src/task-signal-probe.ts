/**
 * @fileoverview Is `task_type` consumed, or accepted and thrown away?
 *
 * The Gemini adapter branches on the configured model: the newer generation
 * is told which side of the retrieval pair it is embedding through a text
 * prefix, the older one through a `task_type` parameter. That branch is only
 * worth its complexity if the two generations really differ, and the
 * difference is invisible from the outside — both return 200 either way, and
 * getting it wrong degrades retrieval with nothing to log.
 *
 * So it is measured, and this file is the measurement. It exists because the
 * numbers it produces are quoted in four places — the adapter's docblock, the
 * CHANGELOG, a commit body and a test comment — and a number whose instrument
 * did not survive the session that produced it is a recollection, not
 * evidence.
 *
 * THE CONTROLS COME FIRST, and without them the rest proves nothing:
 *
 *   - determinism: the same request twice must give the same vector, or
 *     "identical" and "different" both mean noise;
 *   - an invented `task_type` must be REFUSED, or a 200 on the real values
 *     says only that the server ignores the field entirely.
 *
 * What it cannot separate, said here rather than discovered later: "the field
 * is ignored" from "the field is read and makes no difference for this input".
 * Both produce identical vectors. Distinguishing them would need a case where
 * the task genuinely changes the answer, which is a retrieval experiment and
 * not a request-shape one.
 *
 * Usage:  npm run bench:task-signal
 * Reads `TEST_KEY` from the environment, like the rest of `bench/`.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DIMENSIONS = 1536;
const TEXT = 'a resistencia equivalente de resistores em serie';
const MODELS = ['gemini-embedding-001', 'gemini-embedding-2'] as const;

interface Reply {
    readonly status: number;
    readonly values?: readonly number[];
    readonly error?: string;
}

async function call(model: string, body: Record<string, unknown>, key: string): Promise<Reply> {
    const res = await fetch(`${BASE}/models/${model}:embedContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ model: `models/${model}`, output_dimensionality: DIMENSIONS, ...body }),
    });
    const payload = (await res.json().catch(() => ({}))) as {
        embedding?: { values?: number[] };
        error?: { message?: string };
    };
    const values = payload.embedding?.values;
    return values === undefined
        ? { status: res.status, ...(payload.error?.message === undefined ? {} : { error: payload.error.message }) }
        : { status: res.status, values };
}

const identical = (a: readonly number[], b: readonly number[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);

/** Vectors come back unit length, so the dot product is the cosine. */
const cosine = (a: readonly number[], b: readonly number[]): number =>
    a.reduce((sum, v, i) => sum + v * b[i]!, 0);

const content = { parts: [{ text: TEXT }] };
const asQuery = { parts: [{ text: `task: search result | query: ${TEXT}` }] };

function must(reply: Reply, what: string): readonly number[] {
    if (reply.values === undefined) throw new Error(`${what}: ${reply.status} ${reply.error ?? ''}`);
    return reply.values;
}

export async function run(key: string): Promise<string> {
    const out: string[] = [];
    for (const model of MODELS) {
        out.push(`=== ${model} ===`);

        const first = must(await call(model, { content }, key), 'plain');
        const second = must(await call(model, { content }, key), 'plain again');
        out.push(`  determinism (control)        ${identical(first, second) ? 'IDENTICAL' : 'DIFFERS — probe is blind, stop reading'}`);

        const invented = await call(model, { content, task_type: 'NAO_EXISTE_ESSE' }, key);
        out.push(
            `  invented task_type (control) ${invented.values === undefined ? `REFUSED ${invented.status}` : 'ACCEPTED — the field is not validated, so a 200 below proves nothing'}`,
        );

        const query = must(await call(model, { content, task_type: 'RETRIEVAL_QUERY' }, key), 'query');
        const document = must(await call(model, { content, task_type: 'RETRIEVAL_DOCUMENT' }, key), 'document');
        out.push(
            `  QUERY vs DOCUMENT            ${identical(query, document) ? 'IDENTICAL -> accepted and discarded' : `DIFFERS, cos ${cosine(query, document).toFixed(4)} -> CONSUMED`}`,
        );
        out.push(
            `  nothing vs RETRIEVAL_QUERY   ${identical(first, query) ? 'IDENTICAL -> the default is the query side' : `DIFFERS, cos ${cosine(first, query).toFixed(4)}`}`,
        );

        const prefixed = must(await call(model, { content: asQuery }, key), 'prefixed');
        out.push(`  bare text vs prefixed text   cos ${cosine(first, prefixed).toFixed(4)}`);
    }
    out.push('');
    out.push('A prefix is TEXT, so it always changes the vector; the number says how much.');
    out.push('The branch in the adapter is justified only if the two models disagree on the');
    out.push('QUERY vs DOCUMENT line — one CONSUMED and one accepted-and-discarded.');
    return out.join('\n');
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
    const key = process.env['TEST_KEY'];
    if (key === undefined || key === '') throw new Error('TEST_KEY is not set');
    console.log(await run(key));
}
