/**
 * @fileoverview Does a page found as an IMAGE compete with the same page found
 * as TEXT, when the query is a question rather than an excerpt?
 *
 * The question this answers is narrow and it decides one rule: whether a
 * scanned page with no text layer is worth putting in the index at all. If
 * the image arm cannot find the right page from a reader's question, the
 * cheaper answer is to say scanned pages are unreachable rather than to pay
 * for a vector that never wins.
 *
 * THREE ARMS over the same corpus, because two would confound modality with
 * granularity:
 *
 *     image    one vector per page, the whole sheet
 *     text     one vector per page, the whole extracted text   <- same unit
 *     sliced   several vectors per page, ~1200 code points each,
 *              the page scored by its best slice                <- what the
 *                                                                  library does
 *
 * `image` against `text` isolates the modality: same unit, equivalent content.
 * `text` against `sliced` isolates granularity, and tests whether a whole page
 * in one vector is too coarse to discriminate.
 *
 * WHAT THIS FILE IS NOT. It carries no corpus. The pages and the answer key
 * are read from a directory given on the command line, and the run that
 * informed the library's design used copyrighted material that cannot be
 * published — so that particular run is not reproducible from this repository.
 * The METHOD is, against any paged corpus with an answer key.
 *
 * The answer key is the part that decides whether the numbers mean anything.
 * Writing one is not clerical: on the run that informed the design, a blind
 * second reading of the corpus rejected two questions out of ten — one whose
 * answer was on two pages, and one with no answer at all, where the
 * closest-looking page discussed the same objects under the opposite premise
 * and would have been scored as a hit. Have someone who did not write the
 * questions check them against the corpus.
 *
 * Layout of the directory:
 *
 *     <dir>/img/*          one image per page, sorted by name
 *     <dir>/txt/*.txt      the extracted text, same sort order, same count
 *     <dir>/questions.json [{ "question": "...", "pages": [1] }, ...]
 *                          `pages` is 1-based and may hold more than one
 *
 * Usage:  node bench/.out/bench/src/page-arms.js <dir>
 * Reads `TEST_KEY` from the environment, like the rest of `bench/`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MODEL = 'gemini-embedding-2';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DIMENSIONS = 1536;

/** Matches the package default, so `sliced` measures what the library ships. */
const MAX_CHUNK_CODE_POINTS = 1200;

interface Question {
    readonly question: string;
    /** 1-based page numbers that count as a hit. More than one is allowed. */
    readonly pages: readonly number[];
}

interface Row {
    readonly pages: readonly number[];
    readonly image: number;
    readonly text: number;
    readonly sliced: number;
}

async function embed(parts: readonly unknown[], key: string): Promise<readonly number[]> {
    // Retries only the two statuses that are worth retrying. A 400 is a bug in
    // the request and retrying it four times just spends four times as long
    // being wrong.
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await fetch(`${BASE}/models/${MODEL}:embedContent`, {
            method: 'POST',
            headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
            body: JSON.stringify({
                model: `models/${MODEL}`,
                content: { parts },
                output_dimensionality: DIMENSIONS,
            }),
        });
        if (res.status === 429 || res.status >= 500) {
            await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
            continue;
        }
        const body = (await res.json()) as { embedding?: { values?: number[] } };
        const values = body.embedding?.values;
        if (!Array.isArray(values)) {
            throw new Error(`${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
        }
        return values;
    }
    throw new Error('gave up after five attempts');
}

/** Vectors come back normalized, so the dot product is the cosine. */
function cosine(a: readonly number[], b: readonly number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
    return sum;
}

/** Cuts by CODE POINT, which is the unit the package's chunker uses. */
function slice(text: string): readonly string[] {
    const points = [...text];
    const out: string[] = [];
    for (let i = 0; i < points.length; i += MAX_CHUNK_CODE_POINTS) {
        out.push(points.slice(i, i + MAX_CHUNK_CODE_POINTS).join(''));
    }
    return out;
}

/** Position of the best accepted page, 1-based. */
function rankOf(scoreByPage: readonly number[], accept: readonly number[]): number {
    const order = scoreByPage
        .map((score, index) => ({ page: index + 1, score }))
        .sort((a, b) => b.score - a.score);
    return order.findIndex((entry) => accept.includes(entry.page)) + 1;
}

export async function run(dir: string, key: string): Promise<readonly Row[]> {
    const imageFiles = readdirSync(join(dir, 'img')).sort();
    const textFiles = readdirSync(join(dir, 'txt')).filter((f) => f.endsWith('.txt')).sort();
    if (imageFiles.length !== textFiles.length) {
        throw new Error(`img has ${imageFiles.length} files and txt has ${textFiles.length}; they must pair up`);
    }
    const pageCount = imageFiles.length;
    const questions = JSON.parse(readFileSync(join(dir, 'questions.json'), 'utf8')) as readonly Question[];

    for (const { pages, question } of questions) {
        for (const page of pages) {
            if (page >= 1 && page <= pageCount) continue;
            throw new Error(`answer key names page ${page}, outside 1..${pageCount}: ${question.slice(0, 60)}`);
        }
    }

    const imageVectors: (readonly number[])[] = [];
    for (const file of imageFiles) {
        const data = readFileSync(join(dir, 'img', file)).toString('base64');
        imageVectors.push(await embed([{ inlineData: { mimeType: mimeOf(file), data } }], key));
    }

    const raw = textFiles.map((file) => readFileSync(join(dir, 'txt', file), 'utf8').replace(/\s+/gu, ' ').trim());
    const textVectors: (readonly number[])[] = [];
    for (const text of raw) textVectors.push(await embed([{ text: asDocument(text) }], key));

    const sliceVectors: { page: number; vector: readonly number[] }[] = [];
    for (let page = 0; page < pageCount; page += 1) {
        for (const piece of slice(raw[page]!)) {
            sliceVectors.push({ page: page + 1, vector: await embed([{ text: asDocument(piece) }], key) });
        }
    }

    const rows: Row[] = [];
    for (const { question, pages } of questions) {
        const query = await embed([{ text: asQuery(question) }], key);
        const bySlice = new Array<number>(pageCount).fill(Number.NEGATIVE_INFINITY);
        for (const { page, vector } of sliceVectors) {
            bySlice[page - 1] = Math.max(bySlice[page - 1]!, cosine(query, vector));
        }
        rows.push({
            pages,
            image: rankOf(imageVectors.map((v) => cosine(query, v)), pages),
            text: rankOf(textVectors.map((v) => cosine(query, v)), pages),
            sliced: rankOf(bySlice, pages),
        });
    }
    return rows;
}

/** The prefixes `gemini-embedding-2` was trained to read; see the adapter. */
const asQuery = (text: string): string => `task: search result | query: ${text}`;
const asDocument = (text: string): string => `title: none | text: ${text}`;

function mimeOf(file: string): string {
    const lower = file.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.webp')) return 'image/webp';
    throw new Error(`cannot tell the media type of ${file} from its name`);
}

export function report(rows: readonly Row[]): string {
    const lines = [' #  | key      | image | text | sliced'];
    rows.forEach((row, index) => {
        lines.push(
            `${String(index + 1).padStart(2)}  | ${row.pages.join(',').padStart(8)} | ` +
                `${String(row.image).padStart(5)} | ${String(row.text).padStart(4)} | ${String(row.sliced).padStart(6)}`,
        );
    });
    lines.push('');
    const within = (k: number, pick: (r: Row) => number): string =>
        `${rows.filter((r) => pick(r) <= k).length}/${rows.length}`;
    for (const k of [1, 3, 5]) {
        lines.push(
            `hit within ${k}:  image ${within(k, (r) => r.image)}   ` +
                `text ${within(k, (r) => r.text)}   sliced ${within(k, (r) => r.sliced)}`,
        );
    }
    const mrr = (pick: (r: Row) => number): string =>
        (rows.reduce((sum, row) => sum + 1 / pick(row), 0) / rows.length).toFixed(3);
    lines.push('');
    lines.push(`MRR:  image ${mrr((r) => r.image)}   text ${mrr((r) => r.text)}   sliced ${mrr((r) => r.sliced)}`);
    lines.push('');
    lines.push(
        `Read these against the sample size: ${rows.length} question${rows.length === 1 ? '' : 's'}. ` +
            'A difference of one or two is noise. And `sliced` gets several ' +
            'shots per page against one, so part of any lead it has is ' +
            'attempts rather than sharpness.',
    );
    return lines.join('\n');
}

if (process.argv[1]?.endsWith('page-arms.js')) {
    const dir = process.argv[2];
    const key = process.env['TEST_KEY'];
    if (dir === undefined) throw new Error('usage: page-arms <dir>  (expects <dir>/img, <dir>/txt, <dir>/questions.json)');
    if (key === undefined || key === '') throw new Error('TEST_KEY is not set');
    console.log(report(await run(dir, key)));
}
