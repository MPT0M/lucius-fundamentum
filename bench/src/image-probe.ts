/**
 * What `embedContent` accepts as an image, measured against the live endpoint.
 *
 * This exists because the Gemini adapter's own docblock names the failure it
 * prevents: writing an adapter against documentation nobody opened is how a
 * wrong field name becomes a silent degradation. Every request shape and
 * every refusal below was observed, not inferred from a page.
 *
 * It reads `TEST_KEY` from the environment, the same variable the rest of
 * `bench/` uses, and holds no path to anywhere. A probe that knows where one
 * machine keeps its secrets is a probe nobody else can run.
 *
 *     npm run bench:image-probe
 *
 * An earlier header here said `npx vite-node`, which is not a dependency of
 * this package and does not run from a clean clone — the script above does.
 *
 * The fixtures are a 1x1 PNG and a 1x1 JPEG. That is enough to learn request
 * shape, refusal behaviour, and whether the declared MIME changes the result.
 * It says NOTHING about retrieval quality — measuring quality needs real
 * pages, and this file is not that measurement.
 *
 * **What it cannot separate, stated so the conclusion stops where the
 * measurement does.** Observing that a lying MIME yields the same vector
 * shows the declared field does not change the result. It does NOT show the
 * field is ignored: a provider that tries the declared decoder first and
 * falls back to sniffing produces exactly the same observation. Separating
 * those needs a byte stream valid under both labels, which these fixtures are
 * not.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-embedding-2';

/** Smallest valid PNG there is: 1x1, transparent. */
const PNG_1X1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

interface Outcome {
    readonly label: string;
    readonly status: number;
    /**
     * Present on success: the WHOLE vector. An earlier version kept three
     * components "for comparing shapes", and three components were then used
     * to claim two vectors were identical - a claim about 1536 numbers made
     * from three of them.
     */
    readonly vector?: readonly number[];
    /** Present on refusal. The provider's own words, trimmed. */
    readonly message?: string;
}

async function probe(label: string, parts: readonly unknown[], key: string): Promise<Outcome> {
    const res = await fetch(`${BASE}/models/${MODEL}:embedContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
            model: `models/${MODEL}`,
            content: { parts },
            output_dimensionality: 1536,
        }),
    });
    const body: unknown = await res.json().catch(() => null);
    const values = (body as { embedding?: { values?: number[] } } | null)?.embedding?.values;
    if (values) {
        return { label, status: res.status, vector: values };
    }
    const message = (body as { error?: { message?: string } } | null)?.error?.message ?? '';
    return { label, status: res.status, message: message.replace(/\s+/gu, ' ').slice(0, 120) };
}

const image = (mimeType: string | undefined, data: string): unknown => ({
    inlineData: mimeType === undefined ? { data } : { mimeType, data },
});

/** Smallest valid JPEG. Its validity is not assumed: probe 2 sends it as
 *  `image/jpeg`, and a 200 there is what proves these bytes decode. */
const JPEG_1X1 =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
    'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
    'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/** Exact equality over every component. Not closeness, and not a prefix. */
const same = (a: Outcome, b: Outcome): boolean =>
    a.vector !== undefined &&
    b.vector !== undefined &&
    a.vector.length === b.vector.length &&
    a.vector.every((v, i) => v === b.vector![i]);

export async function run(key: string): Promise<readonly Outcome[]> {
    const out: Outcome[] = [];

    // The control. Without it, a refusal below could be an expired key rather
    // than a rejected shape.
    out.push(await probe('text (control)', [{ text: 'task: search result | query: prazo' }], key));

    // Both spellings are documented in the wild. If they differ, the adapter
    // has to pick; if they do not, the question is closed.
    out.push(await probe('image, inline_data (snake)', [{ inline_data: { mime_type: 'image/png', data: PNG_1X1 } }], key));
    out.push(await probe('image, inlineData (camel)', [image('image/png', PNG_1X1)], key));

    // One content carrying both: does it refuse, or embed the pair as one?
    out.push(
        await probe('image + text in one content', [image('image/png', PNG_1X1), { text: 'task: search result | query: lei' }], key),
    );

    // The refusals. Each one the library does NOT have to re-implement.
    out.push(await probe('base64 that is not base64', [image('image/png', 'nao-e-base64!!')], key));
    out.push(await probe('empty data', [image('image/png', '')], key));
    out.push(await probe('missing mimeType', [image(undefined, PNG_1X1)], key));

    // Determinism, before any claim that two vectors are "the same". Without
    // it, equality between two different requests means nothing, because the
    // endpoint was never shown to repeat itself.
    out.push(await probe('same request, run A', [image('image/png', PNG_1X1)], key));
    out.push(await probe('same request, run B', [image('image/png', PNG_1X1)], key));

    // The pair that does NOT refuse, and therefore decides a contract: a MIME
    // that contradicts the bytes, in BOTH directions. One direction alone
    // could be a PNG-shaped coincidence.
    out.push(await probe('JPEG bytes, honest label', [image('image/jpeg', JPEG_1X1)], key));
    out.push(await probe('PNG bytes, lying label (jpeg)', [image('image/jpeg', PNG_1X1)], key));
    out.push(await probe('JPEG bytes, lying label (png)', [image('image/png', JPEG_1X1)], key));

    // The ceiling, in the provider's own unit.
    const six = Array.from({ length: 6 }, () => image('image/png', PNG_1X1));
    out.push(await probe('6 image parts', six, key));
    out.push(await probe('7 image parts', [...six, image('image/png', PNG_1X1)], key));

    return out;
}

function report(outcomes: readonly Outcome[]): void {
    const find = (label: string): Outcome => outcomes.find((o) => o.label === label)!;
    for (const o of outcomes) {
        const detail =
            o.vector !== undefined ? `OK ${o.vector.length}d` : (o.message ?? '');
        console.log(`${o.label.padEnd(40)} ${String(o.status).padStart(3)}  ${detail}`);
    }

    // The comparisons, over every component. Reported as verdicts rather than
    // as three numbers a reader has to eyeball.
    console.log('');
    console.log('--- exact equality over all components ---');
    const pairs: ReadonlyArray<readonly [string, string, string]> = [
        ['deterministic (same request twice)', 'same request, run A', 'same request, run B'],
        ['snake vs camel spelling', 'image, inline_data (snake)', 'image, inlineData (camel)'],
        ['PNG bytes: honest vs lying label', 'image, inlineData (camel)', 'PNG bytes, lying label (jpeg)'],
        ['JPEG bytes: honest vs lying label', 'JPEG bytes, honest label', 'JPEG bytes, lying label (png)'],
        ['different bytes must DIFFER', 'image, inlineData (camel)', 'JPEG bytes, honest label'],
    ];
    for (const [what, a, b] of pairs) {
        console.log(`${what.padEnd(40)} ${same(find(a), find(b)) ? 'IDENTICAL' : 'different'}`);
    }
}

// Run directly, or merely imported? Comparing `import.meta.url` to `argv[1]`
// is the convention the rest of `bench/` uses, and here it is load-bearing
// rather than tidy: without it, importing this module calls a paid endpoint,
// or kills the importing process when the key is absent.
if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
    const key = process.env.TEST_KEY;
    if (key === undefined || key === '') {
        throw new Error('TEST_KEY is not set. This probe calls a paid endpoint and will not guess.');
    }
    report(await run(key));
}
