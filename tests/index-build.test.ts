import { describe, it, expect } from 'vitest';
import {
    createIndex,
    loadIndex,
    CHUNKER_POLICY,
    INDEX_FORMAT_VERSION,
    type IndexArtifact,
} from '../src/index-build.js';
import { createTokenizer } from '../src/tokenizer.js';
import { RSLP_S_FOLDED } from '../src/stemmer.js';
import { readCorpus } from '../bench/src/corpus-probe.js';
import type { SourceDoc } from '../src/chunker.js';

/**
 * Small enough that each sentence is its own chunk, so document frequency is
 * countable by eye. Measured: at 40 the chunker packs two sentences together
 * and the postings stop matching what the fixture looks like it says.
 */
const SMALL = { maxChunkCodePoints: 15, maxOverlapCodePoints: 0 };
const doc = (id: string, text: string): SourceDoc => ({ id, title: id, text });

describe('index — what the artifact records', () => {
    const index = createIndex([doc('d', 'A casa azul.\n\nA casa verde.\n\nO carro azul.')], {
        chunkOptions: SMALL,
    });
    const artifact = index.serialize();

    it('names the tokenizer that built it, stemmer included', () => {
        expect(artifact.tokenizerId).toBe('standard+rslp-s-folded');
        expect(index.tokenizerId).toBe(artifact.tokenizerId);
    });

    it('records the chunking policy as a version of the LOGIC, not of the numbers', () => {
        // The two fixes that opened this lot moved every boundary while
        // leaving 1200 and 160 untouched. A policy derived from the numbers
        // would have claimed compatibility across that change.
        expect(artifact.chunkerPolicy).toBe(CHUNKER_POLICY);
        expect(CHUNKER_POLICY).toBe('v2');
    });

    it('stores the bm25 parameters beside the average they were computed with', () => {
        expect(artifact.bm25.k1).toBe(1.2);
        expect(artifact.bm25.b).toBe(0.75);
        // Three chunks of three tokens each: `a casa azul`, and so on.
        expect(artifact.bm25.averageLength).toBeCloseTo(3, 10);
    });

    it('carries no vectors, and says so with null rather than empty fields', () => {
        expect(artifact.dense).toBeNull();
    });

    it('postings map a term to the chunks that hold it and how often', () => {
        expect(artifact.postings['casa']).toEqual([
            [0, 1],
            [1, 1],
        ]);
        expect(artifact.postings['azul']).toEqual([
            [0, 1],
            [2, 1],
        ]);
        expect(artifact.postings['carro']).toEqual([[2, 1]]);
    });

    it('a content hash identifies the text, so reindexing can skip paying for a vector twice', () => {
        const hashes = artifact.chunks.map((c) => c.contentHash);
        expect(new Set(hashes).size).toBe(hashes.length);
        // Same text, same hash, across separate builds.
        const again = createIndex([doc('d', 'A casa azul.\n\nA casa verde.\n\nO carro azul.')], {
            chunkOptions: SMALL,
        }).serialize();
        expect(again.chunks.map((c) => c.contentHash)).toEqual(hashes);
    });
});

describe('index — the refusals', () => {
    it('refuses an index whose chunks produce no tokens, naming both counts', () => {
        // `averageLength` would be zero, it divides in BM25, every score would
        // be NaN, and NaN in a comparator returns arrival order — a ranking
        // that looks like a ranking. Same class as the negative idf.
        expect(() => createIndex([doc('d', '··· ——— ···')], { chunkOptions: SMALL })).toThrow(
            /0 tokens/,
        );
    });

    it('an empty corpus is not an error, it is an empty index', () => {
        const empty = createIndex([]);
        expect(empty.serialize().chunks).toEqual([]);
        expect(empty.searchLexical('qualquer coisa')).toEqual([]);
    });

    it('search refuses while there are no vectors, and says what to call instead', async () => {
        const index = createIndex([doc('d', 'A casa azul.')], { chunkOptions: SMALL });
        await expect(index.search('casa')).rejects.toThrow(/searchLexical/);
    });

    it('a query whose terms all vanish returns nothing rather than throwing', () => {
        const index = createIndex([doc('d', 'A casa azul.')], { chunkOptions: SMALL });
        expect(index.searchLexical('··· !!! ???')).toEqual([]);
        expect(index.searchLexical('')).toEqual([]);
    });

    it('a query with no match returns nothing', () => {
        const index = createIndex([doc('d', 'A casa azul.')], { chunkOptions: SMALL });
        expect(index.searchLexical('hipopótamo')).toEqual([]);
    });
});

describe('index — serialize and load are the same index', () => {
    const source = [doc('d', 'A casa azul e grande.\n\nA casa verde e pequena.\n\nO carro azul corre.')];
    const built = createIndex(source, { chunkOptions: SMALL });
    const artifact = built.serialize();

    it('a loaded index answers the same query with the same scores', () => {
        const loaded = loadIndex(artifact, { tokenizer: createTokenizer({ stemmer: RSLP_S_FOLDED }) });
        const before = built.searchLexical('casa azul');
        const after = loaded.searchLexical('casa azul');
        expect(after.map((r) => [r.chunk.id, r.score, r.rank])).toEqual(
            before.map((r) => [r.chunk.id, r.score, r.rank]),
        );
        expect(before.length).toBeGreaterThan(0);
    });

    it('refuses a tokenizer that is not the one that indexed, naming both', () => {
        // Terms from another tokenizer would be looked up in postings built by
        // this one, and every miss would read as "not in the corpus".
        const other = createTokenizer();
        expect(() => loadIndex(artifact, { tokenizer: other })).toThrow(/standard\+no-stemmer/);
        expect(() => loadIndex(artifact, { tokenizer: other })).toThrow(/standard\+rslp-s-folded/);
    });

    it('refuses a format it does not know', () => {
        const future: IndexArtifact = { ...artifact, formatVersion: INDEX_FORMAT_VERSION + 1 };
        expect(() => loadIndex(future)).toThrow(new RegExp(String(INDEX_FORMAT_VERSION + 1)));
    });

    it('a loaded artifact keeps saying which chunking logic cut it, not which one is current', () => {
        // Regression: `makeIndex` used to stamp `CHUNKER_POLICY` unconditionally,
        // so an artifact cut under v1 came back out of `loadIndex` + `serialize`
        // claiming v2. The field exists to stop a caller reusing vectors across
        // a boundary change; claiming the current version on old boundaries is
        // the one lie it must never tell.
        const old: IndexArtifact = { ...artifact, chunkerPolicy: 'v1' };
        const reserialized = loadIndex(old, {
            tokenizer: createTokenizer({ stemmer: RSLP_S_FOLDED }),
        }).serialize();
        expect(reserialized.chunkerPolicy).toBe('v1');
        expect(reserialized.chunkerPolicy).not.toBe(CHUNKER_POLICY);
    });

    it('survives a trip through JSON, which is how it will actually travel', () => {
        const roundTripped: IndexArtifact = JSON.parse(JSON.stringify(artifact));
        const loaded = loadIndex(roundTripped, { tokenizer: createTokenizer({ stemmer: RSLP_S_FOLDED }) });
        expect(loaded.searchLexical('casa').map((r) => r.chunk.id)).toEqual(
            built.searchLexical('casa').map((r) => r.chunk.id),
        );
    });
});

describe('index — the ranking', () => {
    const index = createIndex(
        [
            doc(
                'd',
                'A casa azul fica na esquina.\n\n' +
                    'A casa azul da esquina tem uma casa azul ao lado.\n\n' +
                    'O carro vermelho passou.\n\n' +
                    'Uma casa foi vendida.',
            ),
        ],
        { chunkOptions: { maxChunkCodePoints: 60, maxOverlapCodePoints: 0 } },
    );

    it('ranks are 1-based and consecutive', () => {
        const results = index.searchLexical('casa azul');
        expect(results.map((r) => r.rank)).toEqual(results.map((_, i) => i + 1));
    });

    it('scores descend', () => {
        const scores = index.searchLexical('casa azul').map((r) => r.score);
        for (let i = 1; i < scores.length; i += 1) expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    });

    it('a chunk matching both query terms beats one matching only the common one', () => {
        const results = index.searchLexical('casa azul');
        const top = results[0]!;
        expect(top.chunk.text).toContain('azul');
        const onlyCasa = results.find((r) => !r.chunk.text.includes('azul'));
        if (onlyCasa) expect(top.score).toBeGreaterThan(onlyCasa.score);
    });

    it('topK caps the list', () => {
        expect(index.searchLexical('casa', { topK: 2 })).toHaveLength(2);
        expect(index.searchLexical('casa', { topK: 1 })).toHaveLength(1);
    });

    it('the plural in the query finds the singular in the text', () => {
        expect(index.searchLexical('casas').length).toBeGreaterThan(0);
    });

    it('the same query twice gives the same order', () => {
        const a = index.searchLexical('casa azul').map((r) => r.chunk.id);
        const b = index.searchLexical('casa azul').map((r) => r.chunk.id);
        expect(a).toEqual(b);
    });
});

describe('index — the diversity cap', () => {
    const paged: SourceDoc[] = [
        { id: 'p1', title: 'p1', text: 'A casa azul.\n\nA casa verde.\n\nA casa velha.', pageNumber: 1 },
        { id: 'p2', title: 'p2', text: 'A casa nova.', pageNumber: 2 },
    ];
    const index = createIndex(paged, { chunkOptions: SMALL });

    it('takes at most the allowed number from one page', () => {
        const results = index.searchLexical('casa', { maxChunksPerPage: 1 });
        const pages = results.map((r) => r.chunk.pageNumber);
        expect(new Set(pages).size).toBe(pages.length);
    });

    it('a document with no page number is not capped, and the list reaches topK', () => {
        // The cap keys on `pageNumber`; an unpaged source has none, and must
        // not be silently truncated because of it.
        const unpaged = createIndex([doc('d', 'A casa azul.\n\nA casa verde.\n\nA casa velha.')], {
            chunkOptions: SMALL,
        });
        expect(unpaged.searchLexical('casa', { topK: 3, maxChunksPerPage: 1 })).toHaveLength(3);
    });
});

/**
 * The case the whole legal corpus was collected for, run against the corpus
 * as it sits in this repository.
 *
 * `decreto-11713` cites "as estratégias 7.15 e 7.20 da meta 7 do Anexo à Lei
 * nº 13.005"; the strategy itself is in `pne-13005`. The anchor is in one
 * document and the answer in another, joined by a token that occurs in two
 * chunks of the whole corpus. A dense retriever has nothing to work with:
 * `7.15` has no neighbourhood in meaning.
 */
describe('index — the cross-document case', () => {
    const index = createIndex(readCorpus());

    it('the corpus is the one in this repository, and it is big enough to mean something', () => {
        const artifact = index.serialize();
        expect(artifact.chunks.length).toBeGreaterThan(600);
        const documents = new Set(artifact.chunks.map((c) => c.documentId));
        expect(documents.has('pne-13005')).toBe(true);
        expect(documents.has('decreto-11713')).toBe(true);
    });

    it('searching the bare strategy number returns those two chunks and nothing else', () => {
        const results = index.searchLexical('7.15');
        expect(results).toHaveLength(2);
        expect(new Set(results.map((r) => r.chunk.documentId))).toEqual(
            new Set(['pne-13005', 'decreto-11713']),
        );
    });

    it('the number survives as one term instead of shattering into 7 and 15', () => {
        // Without the composite-number rule this query would match every
        // chunk containing a 7 or a 15, which in a corpus of numbered
        // articles is most of them.
        expect(index.searchLexical('7').length).not.toBe(2);
        expect(createTokenizer({ stemmer: RSLP_S_FOLDED }).tokenize('7.15').map((t) => t.term)).toEqual([
            '7.15',
        ]);
    });
});
