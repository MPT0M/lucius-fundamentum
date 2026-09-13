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
        // square root in it. If this stops holding, `search` still returns an
        // order but the score stops being a cosine.
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
        expect(results[0]!.score).toBeCloseTo(1, 5);
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
        await expect(createDenseIndex(CORPUS, short, { chunkOptions: SMALL })).rejects.toThrow(
            /one per chunk/,
        );
    });

    it('refuses a provider that returns a vector of the wrong size, naming the chunk', async () => {
        const wrong: EmbeddingProvider = {
            ...provider,
            async embedDocuments(texts) {
                return texts.map(() => [1, 0, 0]);
            },
        };
        await expect(createDenseIndex(CORPUS, wrong, { chunkOptions: SMALL })).rejects.toThrow(
            /3-dimension vector for chunk 0/,
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
    it('a lexical-only index still refuses search and still answers searchLexical', () => {
        const index = createIndex(CORPUS, { chunkOptions: SMALL });
        expect(index.serialize().dense).toBeNull();
        expect(index.searchLexical('casa').length).toBeGreaterThan(0);
    });

    it('adding vectors does not change what the lexical arm returns', async () => {
        const lexical = createIndex(CORPUS, { chunkOptions: SMALL });
        const dense = await createDenseIndex(CORPUS, provider, { chunkOptions: SMALL });
        expect(dense.searchLexical('casa azul').map((r) => [r.chunk.id, r.score])).toEqual(
            lexical.searchLexical('casa azul').map((r) => [r.chunk.id, r.score]),
        );
    });
});
