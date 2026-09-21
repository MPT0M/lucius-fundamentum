/**
 * A page with no text reaches the index as an image, and the dense arm sends
 * the image rather than the empty string that stands in for its text.
 *
 * Every assertion here guards a failure that produces no error. A page that
 * never becomes a chunk is simply absent from results; a page whose vector
 * came from its empty text is present and unfindable; two pages sharing a
 * content hash swap vectors on the next reindex. None of the three raises
 * anything, and all three look like "retrieval is a bit poor".
 */
import { describe, expect, it, vi } from 'vitest';
import { chunk, DEFAULT_CHUNK_OPTIONS, type PageImage, type SourceDoc } from '../src/chunker.js';
import { createDenseIndex, createIndex } from '../src/index-build.js';
import { deterministicProvider, EmbeddingCheckError, type EmbeddingProvider } from '../src/embedding.js';
import { createTokenizer } from '../src/tokenizer.js';
import { normalize, unpackVectors } from '../src/vector.js';
import { RSLP_S_FOLDED } from '../src/stemmer.js';

const tokenizer = createTokenizer({ stemmer: RSLP_S_FOLDED });
const page = (data: string): PageImage => ({ data, mimeType: 'image/png' });

/** Records what it was handed, so the routing can be asserted on. */
function recorder(dimensions = 4): {
    provider: EmbeddingProvider;
    texts: string[][];
    images: PageImage[][];
} {
    const texts: string[][] = [];
    const images: PageImage[][] = [];
    const vector = (seed: number): number[] => Array.from({ length: dimensions }, (_, i) => (seed + i) % 7);
    const provider: EmbeddingProvider = {
        id: 'recorder',
        dimensions,
        maxInputCodePoints: 100_000,
        modalities: ['text', 'image'],
        async embedDocuments(given) {
            texts.push([...given]);
            return given.map((_, i) => vector(i + 1));
        },
        async embedQuery() {
            return vector(0);
        },
        async embedImages(given) {
            images.push([...given]);
            return given.map((_, i) => vector(i + 100));
        },
    };
    return { provider, texts, images };
}

describe('a page with no text becomes exactly one chunk', () => {
    it('the chunker emits one chunk for it, where it used to emit none', () => {
        const doc: SourceDoc = { id: 'scan', text: '', page: page('AAAA'), pageNumber: 7 };
        const pieces = chunk(doc, DEFAULT_CHUNK_OPTIONS);

        expect(pieces).toHaveLength(1);
        expect(pieces[0]!.id).toBe('scan#0');
        expect(pieces[0]!.pageNumber).toBe(7);
        // The unit of retrieval for a scanned page is the page: there is
        // nothing smaller to point at.
        expect(pieces[0]!.span).toEqual({ start: 0, end: 0 });
    });

    it('its text stays empty, so it contributes no lexical terms', () => {
        // A placeholder in `text` would be indexed, and the page would match
        // queries about the placeholder rather than about the page.
        const index = createIndex([{ id: 'scan', text: '', page: page('AAAA'), pageNumber: 1 }], { tokenizer });
        const artifact = index.serialize();
        expect(artifact.chunks).toHaveLength(1);
        expect(artifact.chunks[0]!.text).toBe('');
        expect(Object.keys(artifact.postings)).toHaveLength(0);
    });
});

describe('the routing: what the dense arm is handed', () => {
    const CORPUS: readonly SourceDoc[] = [
        { id: 'texto', text: 'A corrente eletrica atravessa o condutor.', pageNumber: 1 },
        { id: 'scan', text: '', page: page('PAGINA-DOIS'), pageNumber: 2 },
        { id: 'mais-texto', text: 'O campo magnetico de um solenoide e uniforme dentro dele.', pageNumber: 3 },
    ];

    it('the image goes to embedImages and never to embedDocuments', async () => {
        const { provider, texts, images } = recorder();
        await createDenseIndex(CORPUS, provider, { tokenizer });

        expect(images).toHaveLength(1);
        expect(images[0]).toEqual([page('PAGINA-DOIS')]);

        expect(texts).toHaveLength(1);
        expect(texts[0]!).toHaveLength(2);
        // The empty string standing in for the page's text must not be
        // embedded: a vector of "" would rank against real queries.
        expect(texts[0]).not.toContain('');
    });

    it('every chunk ends up with a vector, in its own position', async () => {
        // The two arms return two lists and the artifact is one. An off-by-one
        // here shifts every later chunk onto its neighbour's vector, and the
        // index still works.
        const { provider } = recorder();
        const artifact = (await createDenseIndex(CORPUS, provider, { tokenizer })).serialize();

        expect(artifact.chunks).toHaveLength(3);
        expect(artifact.dense).not.toBeNull();

        const width = artifact.dense!.dimensions;
        const stored = unpackVectors(artifact.dense!.vectors, width);
        expect(stored).toHaveLength(3);

        // The page's vector came from embedImages, whose seed is 100 and
        // whose text counterpart could never produce it.
        const pageAt = artifact.chunks.findIndex((c) => c.documentId === 'scan');
        const expected = normalize(Array.from({ length: width }, (_, i) => (100 + i) % 7));
        expected.forEach((value, i) => {
            expect(stored[pageAt]![i]).toBeCloseTo(value, 6);
        });
    });

    it('a text-only corpus never touches the image path', async () => {
        const { provider, images } = recorder();
        await createDenseIndex([CORPUS[0]!, CORPUS[2]!], provider, { tokenizer });
        expect(images).toHaveLength(0);
    });

    it('a text-only provider still indexes a text-only corpus', async () => {
        // The modality check must ask only about what the corpus contains.
        // Refusing a text-only provider for a text-only corpus would break
        // every existing caller.
        const textOnly = deterministicProvider(8);
        await expect(createDenseIndex([CORPUS[0]!, CORPUS[2]!], textOnly, { tokenizer })).resolves.toBeDefined();
    });

    it('a text-only provider is refused a corpus containing a page, before paying', async () => {
        const calls = vi.fn();
        const textOnly: EmbeddingProvider = { ...deterministicProvider(8), embedDocuments: calls as never };
        await expect(createDenseIndex(CORPUS, textOnly, { tokenizer })).rejects.toThrow(EmbeddingCheckError);
        await expect(createDenseIndex(CORPUS, textOnly, { tokenizer })).rejects.toThrow(/declares \[text\]/u);
        expect(calls).not.toHaveBeenCalled();
    });

    it('a provider that claims image but implements nothing is named as the bug it is', async () => {
        const liar: EmbeddingProvider = { ...deterministicProvider(8), modalities: ['text', 'image'] };
        await expect(createDenseIndex(CORPUS, liar, { tokenizer })).rejects.toThrow(/implements no embedImages/u);
    });
});

describe('contentHash covers what produced the vector', () => {
    it('two pages with different images get different hashes', async () => {
        // Both have empty text. Hashing the text would give one key for every
        // scanned page in a corpus, and reuse would hand one page's vector to
        // another — silently, which is the failure the field warns about.
        const artifact = createIndex(
            [
                { id: 'a', text: '', page: page('IMAGEM-A'), pageNumber: 1 },
                { id: 'b', text: '', page: page('IMAGEM-B'), pageNumber: 2 },
            ],
            { tokenizer },
        ).serialize();

        expect(artifact.chunks[0]!.contentHash).not.toBe(artifact.chunks[1]!.contentHash);
    });

    it('the same image gives the same hash, so reuse still works', () => {
        const build = (): string =>
            createIndex([{ id: 'a', text: '', page: page('IGUAL'), pageNumber: 1 }], { tokenizer }).serialize()
                .chunks[0]!.contentHash;
        expect(build()).toBe(build());
    });

    it('changing the image changes the hash, with the text held constant', () => {
        const hashOf = (data: string): string =>
            createIndex([{ id: 'a', text: '', page: page(data), pageNumber: 1 }], { tokenizer }).serialize()
                .chunks[0]!.contentHash;
        expect(hashOf('ANTES')).not.toBe(hashOf('DEPOIS'));
    });

    it('a text chunk still hashes its text', () => {
        const a = createIndex([{ id: 'a', text: 'mesma frase aqui.' }], { tokenizer }).serialize();
        const b = createIndex([{ id: 'b', text: 'mesma frase aqui.' }], { tokenizer }).serialize();
        expect(a.chunks[0]!.contentHash).toBe(b.chunks[0]!.contentHash);
    });
});
