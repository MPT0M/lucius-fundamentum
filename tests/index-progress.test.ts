/**
 * `createDenseIndex` reports where it is, and a caller that does not ask gets
 * exactly the build it got before.
 *
 * The second half is the one worth testing. An optional feature that changes
 * the result for callers who ignore it is not optional, and the way that
 * usually happens is an event fired from inside a branch that also does work.
 */
import { describe, expect, it } from 'vitest';
import { createDenseIndex, type IndexBuildState } from '../src/index-build.js';
import { deterministicProvider } from '../src/embedding.js';
import { createTokenizer } from '../src/tokenizer.js';
import { RSLP_S_FOLDED } from '../src/stemmer.js';
import type { SourceDoc } from '../src/chunker.js';

const provider = deterministicProvider(8);
const tokenizer = createTokenizer({ stemmer: RSLP_S_FOLDED });
const SMALL = { maxChunkCodePoints: 120, maxOverlapCodePoints: 20 };

const CORPUS: readonly SourceDoc[] = [
    {
        id: 'circuitos',
        text:
            'A resistencia equivalente de uma associacao em serie e maior do que a maior resistencia presente. ' +
            'Em paralelo, a equivalente e menor do que a menor das resistencias. ' +
            'Um curto-circuito desvia a corrente pelo caminho de menor resistencia.',
        pageNumber: 1,
    },
    {
        id: 'magnetismo',
        text:
            'Um solenoide percorrido por corrente cria um campo magnetico aproximadamente uniforme no interior. ' +
            'Imas nos extremos do solenoide podem ser atraidos ou repelidos.',
        pageNumber: 2,
    },
];

async function statesOf(docs: readonly SourceDoc[]): Promise<readonly IndexBuildState[]> {
    const seen: IndexBuildState[] = [];
    await createDenseIndex(docs, provider, {
        tokenizer,
        chunkOptions: SMALL,
        onState: (event) => seen.push(event),
    });
    return seen;
}

describe('the build reports where it is', () => {
    it('emits the three stages in order, and the counts agree with each other', async () => {
        const seen = await statesOf(CORPUS);

        expect(seen.map((e) => e.kind)).toEqual(['lexical-done', 'embed-start', 'embed-done']);

        const lexical = seen[0] as Extract<IndexBuildState, { kind: 'lexical-done' }>;
        const start = seen[1] as Extract<IndexBuildState, { kind: 'embed-start' }>;
        const done = seen[2] as Extract<IndexBuildState, { kind: 'embed-done' }>;

        expect(lexical.chunks).toBeGreaterThan(1);
        expect(start.total).toBe(lexical.chunks);
        expect(done.total).toBe(start.total);
        // A build that finished embedded everything. If these ever diverge the
        // index is short a vector, and the count is where it shows first.
        expect(done.embedded).toBe(done.total);
    });

    it('an empty corpus still reports start and done, both at zero', async () => {
        // The call is skipped for an empty corpus, and the events are NOT.
        // A caller that shows a bar on `embed-start` and hides it on
        // `embed-done` would otherwise be left holding a bar it never opened.
        const seen = await statesOf([]);
        expect(seen.map((e) => e.kind)).toEqual(['lexical-done', 'embed-start', 'embed-done']);
        expect(seen[2]).toEqual({ kind: 'embed-done', embedded: 0, total: 0 });
    });

    it('carries identifiers and counts, never a sentence to display', async () => {
        // The caller writes the wording and translates it. A phrase emitted
        // from here would be English inside somebody else's interface, and
        // editing it later would be editing their screen.
        for (const event of await statesOf(CORPUS)) {
            for (const value of Object.values(event)) {
                if (typeof value !== 'string') continue;
                expect(value).toMatch(/^[a-z-]+$/u);
            }
        }
    });
});

describe('a caller that does not ask gets the build it always got', () => {
    it('the artifact is identical with and without the callback', async () => {
        const without = (await createDenseIndex(CORPUS, provider, { tokenizer, chunkOptions: SMALL })).serialize();
        const seen: IndexBuildState[] = [];
        const withCallback = (
            await createDenseIndex(CORPUS, provider, {
                tokenizer,
                chunkOptions: SMALL,
                onState: (event) => seen.push(event),
            })
        ).serialize();

        expect(seen.length).toBe(3);
        expect(withCallback).toEqual(without);
    });
});
