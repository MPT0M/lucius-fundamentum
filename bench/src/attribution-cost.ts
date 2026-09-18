/**
 * @fileoverview Where the time goes in one attribution, measured rather than
 * assumed.
 *
 * This probe exists because a single number decided the most visible choice of
 * the single-pass lot: `onState` emits ONE event with duration, not seven, and
 * `provider-wait` is born only when the network will actually be called. Both
 * follow from the local work being fast enough to be invisible.
 *
 * A number that does not survive the session that produced it is a memory, not
 * evidence. It is versioned here so a reader can disagree with the measurement
 * instead of with the claim.
 *
 * Run it with `npm run bench:cost`. The table prints only when this file is the
 * entry point — the guard `corpus-probe.ts` also has — so importing `measure`
 * measures nothing.
 *
 * The SCRIPT is not run by CI. The TEST beside it is, and the distinction is
 * the whole arrangement: timing on a shared runner measures the runner, so what
 * that test asserts is the shape of the conclusion plus a collapse ceiling far
 * above any figure this machine produces.
 */

import { attributeLexical, createIndex, createTokenizer } from '../../src/index.js';
import type { SearchResult, SourceDoc } from '../../src/index.js';

/** Five sentences of statute, repeated until the document is realistic. */
const BASE =
    'O prazo para recurso é de 15 dias corridos. ' +
    'A contagem exclui o dia inicial e inclui o do vencimento. ' +
    'O relator pode conceder efeito suspensivo ao agravo. ' +
    'A perícia contábil será custeada pela parte requerente. ' +
    'O prazo em dobro alcança 30 dias no caso de litisconsórcio. ';

/** The length a model actually writes, not a fixture-sized answer. */
const ANSWER = (
    'O prazo para interpor recurso é de quinze dias corridos. ' +
    'A contagem não inclui o dia em que a decisão foi publicada. ' +
    'Quem julga o caso pode suspender os efeitos enquanto ele corre. ' +
    'O custo da perícia recai sobre quem a pediu. ' +
    'Havendo litisconsórcio, esse prazo dobra. '
).repeat(6);

const RUNS = 20;

/**
 * The latency a provider adds, ASSUMED and not observed.
 *
 * Kept as a named constant so that nobody reads the total below as a
 * measurement. Vary it and the conclusion does not move, which is the point:
 * at 50 ms or at 2 s the local work stays an order of magnitude under.
 */
const ASSUMED_PROVIDER_MS = 450;
const PROVIDER_CALLS = 2;

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1]! + sorted[middle]!) / 2
        : sorted[middle]!;
}

export function measure(): {
    readonly documentCodePoints: number;
    readonly answerCodePoints: number;
    readonly candidates: number;
    readonly localMedianMs: number;
    readonly modelledTotalMs: number;
    readonly localFraction: number;
} {
    const doc: SourceDoc = { id: 'lei', title: 'Lei', text: BASE.repeat(120) };
    const tokenizer = createTokenizer();
    const index = createIndex([doc], { tokenizer });
    const results: readonly SearchResult[] = index.searchLexical(
        'prazo recurso contagem relator perícia dobro',
        { topK: 10 },
    );

    // Warm the engine so the first run does not measure compilation.
    for (let i = 0; i < 3; i += 1) attributeLexical(ANSWER, results, { tokenizer });

    const samples: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
        const started = performance.now();
        attributeLexical(ANSWER, results, { tokenizer });
        samples.push(performance.now() - started);
    }

    const localMedianMs = median(samples);
    const modelledTotalMs = localMedianMs + ASSUMED_PROVIDER_MS * PROVIDER_CALLS;

    return {
        documentCodePoints: Array.from(doc.text).length,
        answerCodePoints: Array.from(ANSWER).length,
        candidates: results.length,
        localMedianMs,
        modelledTotalMs,
        localFraction: localMedianMs / modelledTotalMs,
    };
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
    const out = measure();
    console.log(`document ................ ${out.documentCodePoints} code points`);
    console.log(`answer .................. ${out.answerCodePoints} code points`);
    console.log(`candidates .............. ${out.candidates}`);
    console.log('');
    console.log(`MEASURED   local work ... ${out.localMedianMs.toFixed(1)} ms  (median of ${RUNS})`);
    console.log(`MODELLED   total ........ ${out.modelledTotalMs.toFixed(0)} ms  ` +
        `(${PROVIDER_CALLS} calls at an ASSUMED ${ASSUMED_PROVIDER_MS} ms)`);
    console.log(`           local share .. ${(out.localFraction * 100).toFixed(1)}%`);
}
