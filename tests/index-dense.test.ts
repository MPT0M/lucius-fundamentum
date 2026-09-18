import { describe, it, expect } from 'vitest';
import { createIndex, createDenseIndex, loadIndex, type IndexArtifact } from '../src/index-build.js';
import { deterministicProvider, type EmbeddingProvider } from '../src/embedding.js';
import { createTokenizer } from '../src/tokenizer.js';
import { RSLP_S_FOLDED } from '../src/stemmer.js';
import { unpackVectors, packVectors, norm } from '../src/vector.js';
import type { SourceDoc } from '../src/chunker.js';

const SMALL = { maxChunkCodePoints: 15, maxOverlapCodePoints: 0 };
const doc = (id: string, text: string): SourceDoc => ({ id, title: id, text });
const CORPUS = [doc('d', 'A casa azul.\n\nA casa verde.\n\nO carro azul.')];

const provider = deterministicProvider(8);

// A provider that lets the test place each chunk in the dense ranking by
// hand, so the fusion can be exercised against a KNOWN pair of lists
// rather than against whatever the hash happens to produce.
const placed = (order: readonly string[]): EmbeddingProvider => ({
    id: 'placed',
    dimensions: 2,
    maxInputCodePoints: 1000,
    async embedDocuments(texts) {
        // Closer to [1,0] the earlier the text appears in `order`.
        return texts.map((text) => {
            const i = order.findIndex((needle) => text.includes(needle));
            const angle = (i === -1 ? order.length : i) * 0.3;
            return [Math.cos(angle), Math.sin(angle)];
        });
    },
    async embedQuery() {
        return [1, 0];
    },
});

describe('dense — what the artifact stores', () => {
    it('carries one vector per chunk, and says which provider made them', async () => {
        const index = await createDenseIndex(CORPUS, provider, { chunkOptions: SMALL });
        const artifact = index.serialize();
        expect(artifact.dense).not.toBeNull();
        expect(artifact.dense!.providerId).toBe('deterministic-8');
        expect(artifact.dense!.dimensions).toBe(8);
        expect(unpackVectors(artifact.dense!.vectors, 8)).toHaveLength(artifact.chunks.length);
    });

    it('the stored vectors are already unit length, so the query is a dot product', async () => {
        // Normalizing at index time is the whole reason the hot loop has no
        // square root in it. If this stops holding, the dense arm's dot
        // product stops being a cosine and its ranking is distorted before
        // the fusion ever sees it — `search` still returns an order, and the
        // order is wrong for a reason nothing downstream can detect.
        const index = await createDenseIndex(CORPUS, provider, { chunkOptions: SMALL });
        for (const v of unpackVectors(index.serialize().dense!.vectors, 8)) {
            expect(norm(v)).toBeCloseTo(1, 5);
        }
    });

    it('an empty corpus is an empty dense arm, not an error', async () => {
        const index = await createDenseIndex([], provider);
        expect(index.serialize().chunks).toEqual([]);
        expect(await index.search('qualquer coisa')).toEqual([]);
    });
});

describe('dense — search', () => {
    it('ranks are 1-based and consecutive, and scores descend', async () => {
        const index = await createDenseIndex(CORPUS, provider, { chunkOptions: SMALL });
        const results = await index.search('casa azul');
        expect(results.map((r) => r.rank)).toEqual(results.map((_, i) => i + 1));
        for (let i = 1; i < results.length; i += 1) {
            expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
        }
    });

    it('a chunk whose exact text is the query comes first', async () => {
        // The deterministic provider knows no meaning, but identical text
        // embeds identically — so this is the one ranking property it can
        // honestly demonstrate, and it exercises the whole path.
        const index = await createDenseIndex(CORPUS, provider, { chunkOptions: SMALL });
        const first = index.serialize().chunks[0]!;
        const results = await index.search(first.text);
        expect(results[0]!.chunk.id).toBe(first.id);

        // The cosine assertion that stood here was removed deliberately when
        // `search` became the fusion: `score` is no longer a cosine, it is the
        // reciprocal-rank sum, and a chunk ranked first by both arms scores
        // 2/(60+1) = 0.0328 rather than 1. The property worth keeping is the
        // ORDER, above. The score's new meaning is pinned in its own test.
        expect(results[0]!.score).toBeCloseTo(2 / (60 + 1), 6);
    });

    it('topK caps the list and the page cap still applies', async () => {
        const paged: SourceDoc[] = [
            { id: 'p1', title: 'p1', text: 'A casa azul.\n\nA casa verde.\n\nA casa velha.', pageNumber: 1 },
            { id: 'p2', title: 'p2', text: 'A casa nova.', pageNumber: 2 },
        ];
        const index = await createDenseIndex(paged, provider, { chunkOptions: SMALL });
        expect(await index.search('casa', { topK: 2 })).toHaveLength(2);
        const capped = await index.search('casa', { maxChunksPerPage: 1 });
        const pages = capped.map((r) => r.chunk.pageNumber);
        // Without this line the assertion below passes on a single result —
        // a Set of one has size one — so a cap that returned nothing useful
        // would look like a cap that worked.
        expect(capped.length).toBeGreaterThan(1);
        expect(new Set(pages).size).toBe(pages.length);
    });

    it('the same query twice gives the same order', async () => {
        const index = await createDenseIndex(CORPUS, provider, { chunkOptions: SMALL });
        const a = (await index.search('casa azul')).map((r) => r.chunk.id);
        const b = (await index.search('casa azul')).map((r) => r.chunk.id);
        expect(a).toEqual(b);
    });
});

describe('dense — each door is used at the right end', () => {
    it('indexing goes through embedDocuments and searching through embedQuery', async () => {
        // The reason the interface has two methods instead of one flag is that
        // the two ends are genuinely different calls for most providers. That
        // buys nothing unless the library actually uses the right one at each
        // end — and swapping them would still return vectors, still rank, and
        // still be wrong, with no symptom. So the routing is pinned.
        const seen: string[] = [];
        const watcher: EmbeddingProvider = {
            id: 'watcher',
            dimensions: 4,
            maxInputCodePoints: 1000,
            async embedDocuments(texts) {
                seen.push(`documents:${texts.length}`);
                return texts.map(() => [1, 0, 0, 0]);
            },
            async embedQuery(text) {
                seen.push(`query:${text}`);
                return [1, 0, 0, 0];
            },
        };

        const index = await createDenseIndex(CORPUS, watcher, { chunkOptions: SMALL });
        expect(seen).toEqual(['documents:3']);

        await index.search('a casa');
        expect(seen).toEqual(['documents:3', 'query:a casa']);
    });
});

describe('dense — a chunk pointing away from the query is absent, not last', () => {
    it('omits chunks whose cosine is zero or negative', async () => {
        // Two chunks placed by hand at right angles and in opposition to the
        // query. Ranking them last would look harmless and is not: with a topK
        // of ten and three related chunks, the list would be padded with the
        // seven LEAST related chunks in the corpus, each carrying a rank that
        // reads as relevance.
        const opposed: EmbeddingProvider = {
            id: 'opposed',
            dimensions: 2,
            maxInputCodePoints: 1000,
            async embedDocuments(texts) {
                return texts.map((text) => {
                    if (text.includes('alinhado')) return [1, 0];
                    if (text.includes('ortogonal')) return [0, 1];
                    return [-1, 0];
                });
            },
            async embedQuery() {
                return [1, 0];
            },
        };
        const docs = [doc('d', ['Trecho alinhado.', 'Trecho ortogonal.', 'Trecho oposto.'].join('\n\n'))];
        const index = await createDenseIndex(docs, opposed, { chunkOptions: SMALL });

        const results = await index.search('alinhado');
        expect(results).toHaveLength(1);
        expect(results[0]!.chunk.text).toContain('alinhado');
        expect(results[0]!.score).toBeGreaterThan(0);
    });
});

describe('dense — serialize and load are the same index', () => {
    it('a loaded index answers the same query with the same scores', async () => {
        const built = await createDenseIndex(CORPUS, provider, { chunkOptions: SMALL });
        const artifact = JSON.parse(JSON.stringify(built.serialize())) as IndexArtifact;
        const loaded = loadIndex(artifact, { tokenizer: createTokenizer({ stemmer: RSLP_S_FOLDED }), provider });
        const before = await built.search('casa azul');
        const after = await loaded.search('casa azul');
        expect(after.map((r) => [r.chunk.id, r.rank])).toEqual(before.map((r) => [r.chunk.id, r.rank]));
        for (let i = 0; i < before.length; i += 1) {
            expect(after[i]!.score).toBeCloseTo(before[i]!.score, 5);
        }
    });

    it('an artifact with vectors but no provider stays lexical, and search says why', async () => {
        const artifact = (await createDenseIndex(CORPUS, provider, { chunkOptions: SMALL })).serialize();
        const loaded = loadIndex(artifact, { tokenizer: createTokenizer({ stemmer: RSLP_S_FOLDED }) });
        expect(loaded.searchLexical('casa').length).toBeGreaterThan(0);
        await expect(loaded.search('casa')).rejects.toThrow(/searchLexical/);
    });
});

describe('dense — the refusals', () => {
    const other: EmbeddingProvider = {
        id: 'outro-provedor',
        dimensions: 8,
        maxInputCodePoints: 1000,
        async embedDocuments(texts) {
            return texts.map(() => Array.from({ length: 8 }, () => 1 / Math.sqrt(8)));
        },
        async embedQuery() {
            return Array.from({ length: 8 }, () => 1 / Math.sqrt(8));
        },
    };

    it('refuses a provider that is not the one that embedded, naming both', async () => {
        const artifact = (await createDenseIndex(CORPUS, provider, { chunkOptions: SMALL })).serialize();
        expect(() => loadIndex(artifact, { tokenizer: createTokenizer({ stemmer: RSLP_S_FOLDED }), provider: other })).toThrow(
            /deterministic-8/,
        );
        expect(() => loadIndex(artifact, { tokenizer: createTokenizer({ stemmer: RSLP_S_FOLDED }), provider: other })).toThrow(
            /outro-provedor/,
        );
    });

    it('refuses a query vector of the wrong width, not only a chunk vector', async () => {
        // The refusal at query time is the fourth of four in this file, and it
        // was the one the commit body did not enumerate and no test pinned —
        // the same item missing from both lists, which is how a gap survives a
        // review. The build-time twin was covered; this one asserts the message
        // that names the query, so the two cannot be confused.
        const index = await createDenseIndex(CORPUS, provider, { chunkOptions: SMALL });
        const artifact = index.serialize();

        const shrinksTheQuery: EmbeddingProvider = {
            ...provider,
            embedQuery: async () => [0.1, 0.2, 0.3],
        };
        const loaded = loadIndex(artifact, {
            tokenizer: createTokenizer({ stemmer: RSLP_S_FOLDED }),
            provider: shrinksTheQuery,
        });
        await expect(loaded.search('casa')).rejects.toThrow(/3-dimension vector for the query/);
    });

    it('an artifact from the lexical release loads lexically instead of throwing a TypeError', () => {
        // Regression. `dense` became a required field of IndexArtifact while
        // INDEX_FORMAT_VERSION stayed 1, so an artifact written before the
        // dense arm existed passes the version check carrying no `dense` key
        // at all. The absence test was `=== null`, which does not match
        // `undefined`, and the load fell through to read `.providerId` off it:
        // a raw TypeError out of the function whose job is refusing artifacts.
        const artifact = createIndex(CORPUS, { chunkOptions: SMALL }).serialize();
        const fromOldRelease = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
        delete fromOldRelease.dense;
        expect('dense' in fromOldRelease).toBe(false);

        const tokenizer = createTokenizer({ stemmer: RSLP_S_FOLDED });
        const index = loadIndex(fromOldRelease as unknown as IndexArtifact, { tokenizer, provider });

        // It has no vectors, so the lexical arm answers and `search` refuses
        // by name rather than by crashing.
        expect(index.searchLexical('casa').length).toBeGreaterThan(0);
        expect(index.serialize().dense).toBeNull();
    });

    it('refuses an artifact whose dense section is present but not shaped like one', () => {
        // The third case the absence test used to collapse into the first: a
        // payload truncated or hand-edited between the key and its contents
        // would otherwise fail on a property of the wrong type, far from here.
        const artifact = createIndex(CORPUS, { chunkOptions: SMALL }).serialize();
        const mangled = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
        mangled.dense = { providerId: 'x', dimensions: 'oito', vectors: '' };

        const tokenizer = createTokenizer({ stemmer: RSLP_S_FOLDED });
        expect(() =>
            loadIndex(mangled as unknown as IndexArtifact, { tokenizer, provider }),
        ).toThrow(/not shaped like one/);
    });

    it('refuses a provider whose dimensions disagree with the artifact', async () => {
        const artifact = (await createDenseIndex(CORPUS, provider, { chunkOptions: SMALL })).serialize();
        const wrongSize: EmbeddingProvider = { ...provider, dimensions: 16 };
        expect(() => loadIndex(artifact, { tokenizer: createTokenizer({ stemmer: RSLP_S_FOLDED }), provider: wrongSize })).toThrow(
            /16 dimensions but the artifact stores 8/,
        );
    });

    it('refuses an artifact carrying one vector fewer than it has chunks', async () => {
        // A WELL-FORMED payload with the wrong count: every vector decodes, and
        // the last chunk simply has none. Without this guard the mismatch is
        // silent and the tail of the corpus scores against nothing. Cutting the
        // base64 by hand would instead produce a malformed payload, which a
        // different guard already refuses — a real hazard, but not this one.
        const artifact = (await createDenseIndex(CORPUS, provider, { chunkOptions: SMALL })).serialize();
        const all = unpackVectors(artifact.dense!.vectors, 8);
        expect(all.length).toBeGreaterThan(1);
        const truncated: IndexArtifact = {
            ...artifact,
            dense: { ...artifact.dense!, vectors: packVectors(all.slice(0, -1)) },
        };
        expect(() => loadIndex(truncated, { tokenizer: createTokenizer({ stemmer: RSLP_S_FOLDED }), provider })).toThrow(
            /one per chunk/,
        );
    });

    it('refuses a provider that returns fewer vectors than chunks', async () => {
        // The off-by-one with no symptom: every chunk after the gap would be
        // scored against its neighbour's vector, forever, silently.
        const short: EmbeddingProvider = {
            ...provider,
            async embedDocuments(texts) {
                return (await provider.embedDocuments(texts)).slice(0, -1);
            },
        };
        // A guarda mudou de casa para `embedding.ts` e passou a servir dois
        // chamadores, entao a mensagem fala de INPUT e nao de chunk: o
        // atribuidor embeda oracoes, que nao sao chunks. Mudanca deliberada.
        await expect(createDenseIndex(CORPUS, short, { chunkOptions: SMALL })).rejects.toThrow(
            /exactly one per input/,
        );
    });

    it('refuses a provider that returns a vector of the wrong size, naming the input', async () => {
        const wrong: EmbeddingProvider = {
            ...provider,
            async embedDocuments(texts) {
                return texts.map(() => [1, 0, 0]);
            },
        };
        await expect(createDenseIndex(CORPUS, wrong, { chunkOptions: SMALL })).rejects.toThrow(
            /3-dimension vector for input 0/,
        );
    });
});

describe('dense — the window guard runs before anything is paid for', () => {
    it('refuses the ceiling without calling the provider once', async () => {
        let calls = 0;
        const narrow: EmbeddingProvider = {
            id: 'narrow',
            dimensions: 8,
            maxInputCodePoints: 10,
            async embedDocuments(texts) {
                calls += 1;
                return texts.map(() => Array.from({ length: 8 }, () => 1 / Math.sqrt(8)));
            },
            async embedQuery() {
                calls += 1;
                return Array.from({ length: 8 }, () => 1 / Math.sqrt(8));
            },
        };
        await expect(createDenseIndex(CORPUS, narrow, { chunkOptions: SMALL })).rejects.toThrow(
            /exceeds the window/,
        );
        expect(calls).toBe(0);
    });

    it('refuses the chunk that does not fit even when the ceiling did, naming it', async () => {
        // The second layer exists because the ceiling is a budget: a sentence
        // longer than it is emitted whole. Here the parameter fits the window
        // and a chunk does not.
        const narrow: EmbeddingProvider = {
            id: 'narrow',
            dimensions: 8,
            maxInputCodePoints: 20,
            async embedDocuments(texts) {
                return texts.map(() => Array.from({ length: 8 }, () => 1 / Math.sqrt(8)));
            },
            async embedQuery() {
                return Array.from({ length: 8 }, () => 1 / Math.sqrt(8));
            },
        };
        const long = [doc('d', 'Uma frase única e bastante longa que passa do teto sem ponto no meio.')];
        await expect(
            createDenseIndex(long, narrow, { chunkOptions: { maxChunkCodePoints: 20, maxOverlapCodePoints: 0 } }),
        ).rejects.toThrow(/d#0/);
    });
});

describe('dense — the lexical arm is untouched', () => {
    it('a lexical-only index still refuses search and still answers searchLexical', async () => {
        const index = createIndex(CORPUS, { chunkOptions: SMALL });
        expect(index.serialize().dense).toBeNull();
        expect(index.searchLexical('casa').length).toBeGreaterThan(0);
        // The refusal is half of what this test is named for, and it used to
        // go unasserted: the body checked the artifact and the lexical arm and
        // never called `search`, so the promise in the title was decoration.
        await expect(index.search('casa')).rejects.toThrow(/searchLexical/);
    });

    it('adding vectors does not change what the lexical arm returns', async () => {
        const lexical = createIndex(CORPUS, { chunkOptions: SMALL });
        const dense = await createDenseIndex(CORPUS, provider, { chunkOptions: SMALL });
        expect(dense.searchLexical('casa azul').map((r) => [r.chunk.id, r.score])).toEqual(
            lexical.searchLexical('casa azul').map((r) => [r.chunk.id, r.score]),
        );
    });
});

describe('fusion — agreement between the two arms beats leadership in one', () => {
    const DOCS = [
        doc('d', ['Alfa bravo.', 'Charlie delta.', 'Echo foxtrot.', 'Golf hotel.'].join('\n\n')),
    ];

    it('a chunk both arms found beats a chunk one arm ranked first', async () => {
        // The fixture is built so that fusion and dense-alone DISAGREE, which
        // is the only way this test can be about fusion at all. An earlier
        // version picked a winner that won either way, and passed with the
        // lexical list removed entirely.
        //
        //   query "alfa"
        //   lexical:  Alfa rank 1, nothing else matches the term
        //   dense:    Charlie 1, Echo 2, Alfa 3, Golf 4
        //
        //   Alfa    = 1/61 + 1/63 = 0.0323   <- found by both
        //   Charlie = 1/61        = 0.0164   <- first in one, absent from the other
        //
        // Dense alone puts Charlie first. Fusion puts Alfa first, because
        // agreement between two arms that fail differently outweighs
        // leadership in one.
        const index = await createDenseIndex(DOCS, placed(['Charlie', 'Echo', 'Alfa', 'Golf']), {
            chunkOptions: SMALL,
        });
        const results = await index.search('alfa');

        expect(results[0]!.chunk.text).toContain('Alfa');
        expect(results[0]!.score).toBeCloseTo(1 / 61 + 1 / 63, 6);
        expect(results[1]!.chunk.text).toContain('Charlie');
    });

    it('the score is the reciprocal-rank sum, not a similarity', async () => {
        // Pinned because the number changed meaning when `search` became the
        // fusion, and a caller thresholding on it would read 0.03 as "3%".
        const index = await createDenseIndex(DOCS, placed(['Alfa', 'Charlie', 'Echo', 'Golf']), {
            chunkOptions: SMALL,
        });
        const results = await index.search('alfa');
        // First in both lists: 1/(60+1) twice.
        expect(results[0]!.score).toBeCloseTo(2 / 61, 6);
        expect(results[0]!.score).toBeLessThan(0.04);
    });

    it('every chunk an arm ranked within the depth reaches the fused list', async () => {
        // "zulu" is in no chunk, so the lexical arm contributes nothing and
        // the whole result came through the dense arm alone: fusion must not
        // REQUIRE agreement, only reward it.
        //
        // Asserting the full count is what makes this a test of FUSION_DEPTH.
        // Asserting only that the first result is there passed with the depth
        // cut to 1 — a list truncated to a single item still has a correct
        // first item.
        const index = await createDenseIndex(DOCS, placed(['Golf', 'Echo', 'Charlie', 'Alfa']), {
            chunkOptions: SMALL,
        });
        const results = await index.search('zulu');

        expect(results).toHaveLength(4);
        expect(results[0]!.chunk.text).toContain('Golf');
        expect(results[0]!.score).toBeCloseTo(1 / 61, 6);
        // Fourth in the only list that found it: 1/(60+4).
        expect(results[3]!.score).toBeCloseTo(1 / 64, 6);
    });

    it('the page cap is applied to the fused list, not to each arm', async () => {
        // Capping per arm would drop a chunk from one list for a reason that
        // is not its relevance, and the fusion would read that absence as the
        // arm ranking it low — a chunk penalised for a cap it never met.
        //
        // The fixture has to make the two rules DISAGREE about which chunk
        // wins page 1, or the test passes under both. An earlier version did
        // not: its page-1 winner led both arms, so it won either way, and the
        // test stayed green with the cap moved inside the arms — testing the
        // half of its own name it was written to protect.
        //
        //   page 1  'bravo'   lexical 1st, dense 3rd  -> 1/61 + 1/63 = 0.03227
        //   page 1  'charlie' lexical 2nd, dense 1st  -> 1/62 + 1/61 = 0.03252
        //   page 2  'delta'   lexical 3rd, dense 2nd
        //
        // The three chunks are the same length and each holds the query term
        // once, so their BM25 scores are identical and the lexical order above
        // comes entirely from the tie rule, not from relevance. That is fine
        // here — inverting the tie rule still leaves 'charlie' winning page 1,
        // checked by hand — but the table reads like a ranking and is not one.
        //
        // Fused first, capped after: 'charlie' outscores 'bravo' and takes
        // page 1. Capped inside the arms: the lexical arm fills page 1 with
        // 'bravo' and drops 'charlie', which then carries only its dense
        // 1/61 = 0.01639 and loses the page it should have won.
        const paged: SourceDoc[] = [
            { id: 'p1', title: 'p1', text: 'Alfa bravo.\n\nAlfa charlie.', pageNumber: 1 },
            { id: 'p2', title: 'p2', text: 'Alfa delta.', pageNumber: 2 },
        ];
        const index = await createDenseIndex(paged, placed(['Alfa charlie', 'Alfa delta', 'Alfa bravo']), {
            chunkOptions: SMALL,
        });
        const capped = await index.search('alfa', { maxChunksPerPage: 1 });

        expect(capped.length).toBeGreaterThan(1);
        const pages = capped.map((r) => r.chunk.pageNumber);
        expect(new Set(pages).size).toBe(pages.length);

        // The assertion that distinguishes the two rules.
        const fromPageOne = capped.find((r) => r.chunk.pageNumber === 1)!;
        expect(fromPageOne.chunk.text).toContain('charlie');
        expect(fromPageOne.score).toBeCloseTo(1 / 62 + 1 / 61, 6);
    });

    it('without page numbers the cap does not apply, so topK survives', async () => {
        // The corpus the ruler measures is a .txt with no pages. Grouping by
        // an absent pageNumber would put every chunk in one group and cut the
        // list to the cap, making recall@10 unable to exceed recall@3 for a
        // reason that has nothing to do with search.
        const index = await createDenseIndex(DOCS, placed(['Alfa', 'Charlie', 'Echo', 'Golf']), {
            chunkOptions: SMALL,
        });
        const results = await index.search('alfa charlie echo golf', { maxChunksPerPage: 1 });
        expect(results.every((r) => r.chunk.pageNumber === undefined)).toBe(true);
        expect(results.length).toBeGreaterThan(1);
    });
});

describe('fusion — the two cases production hits that the fixtures did not', () => {
    it('an empty corpus answers without paying for a query embedding', async () => {
        // The sibling test asserts the empty result and stops there, which a
        // refactor moving the guard below `embedQuery` would still satisfy —
        // while paying a provider call on every search of an empty index. The
        // property worth protecting is the call that does not happen.
        let calls = 0;
        const counted: EmbeddingProvider = {
            id: 'counted',
            dimensions: 8,
            // Wide enough that the window guard never fires: this test is
            // about the call that is NOT made, and a refusal before the call
            // would satisfy it for the wrong reason.
            maxInputCodePoints: 1_000_000,
            async embedDocuments(texts) {
                calls += 1;
                return texts.map(() => Array.from({ length: 8 }, () => 1 / Math.sqrt(8)));
            },
            async embedQuery() {
                calls += 1;
                return Array.from({ length: 8 }, () => 1 / Math.sqrt(8));
            },
        };

        const index = await createDenseIndex([], counted);
        const before = calls;
        expect(await index.search('qualquer coisa')).toEqual([]);
        expect(calls).toBe(before);
    });

    it('two chunks each found by one arm at the same rank tie, and corpus order breaks the tie', async () => {
        // The most frequent shape of disagreement in production, and nothing
        // exercised it: each arm finds a different chunk and ranks it the same.
        // Both score 1/(60+r), and in IEEE-754 that is the SAME double, not a
        // near-miss — so the winner is decided entirely by `x[0] - y[0]` in the
        // ordering rule, which is the chunk's position in the corpus.
        //
        // Stated plainly: when the two arms disagree evenly, the chunk that
        // appears earlier in the document wins. That is a systematic bias
        // toward the start of a text, and it is a consequence of the tie rule
        // rather than a decision anyone took.
        const docs = [doc('d', ['Alfa bravo.', 'Charlie delta.'].join('\n\n'))];

        // Each arm finds exactly one chunk, and puts it first.
        //   lexical: the query term reaches only Alfa      -> Alfa   rank 1
        //   dense:   Alfa points away and is filtered out  -> Charlie rank 1
        // So both score 1/(60+1) and neither has a second contribution.
        const opposed: EmbeddingProvider = {
            id: 'opposed',
            dimensions: 2,
            maxInputCodePoints: 1_000_000,
            async embedDocuments(texts) {
                return texts.map((text) => (text.includes('Alfa') ? [-1, 0] : [1, 0]));
            },
            async embedQuery() {
                return [1, 0];
            },
        };
        const index = await createDenseIndex(docs, opposed, { chunkOptions: SMALL });
        const results = await index.search('alfa');

        expect(results).toHaveLength(2);
        const [first, second] = results;

        // `toBe`, not `toBeCloseTo`: the point is that the two doubles are the
        // same value, not that they are near. If they merely rounded close,
        // the sort would still order them by score and corpus position would
        // never be consulted.
        expect(first!.score).toBe(second!.score);
        expect(first!.score).toBe(1 / 61);

        // And the winner is the chunk that appears earlier in the document —
        // decided entirely by `x[0] - y[0]` in the ordering rule, with nothing
        // about relevance in it.
        expect(first!.chunk.text).toContain('Alfa');
        expect(second!.chunk.text).toContain('Charlie');
    });
});
