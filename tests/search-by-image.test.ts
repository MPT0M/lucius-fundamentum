/**
 * Searching with an image: photograph a diagram, find the material that
 * covers it.
 *
 * The case is narrow and the failure modes are not. An image query has no
 * terms, so it must not reach the lexical arm; and it must not be scored
 * against a fused list that assumes both arms could have ranked it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDenseIndex, isImageQuery } from '../src/index-build.js';
import { deterministicProvider, type EmbeddingProvider } from '../src/embedding.js';
import { createTokenizer } from '../src/tokenizer.js';
import { RSLP_S_FOLDED } from '../src/stemmer.js';
import type { PageImage, SourceDoc } from '../src/chunker.js';

const tokenizer = createTokenizer({ stemmer: RSLP_S_FOLDED });
const DIMENSIONS = 6;
const picture: PageImage = { data: 'FOTO-DE-UM-GRAFICO', mimeType: 'image/jpeg' };

const CORPUS: readonly SourceDoc[] = [
    { id: 'serie', text: 'A resistencia equivalente em serie e maior que a maior das resistencias.', pageNumber: 1 },
    { id: 'paralelo', text: 'Em paralelo a equivalente e menor que a menor das resistencias.', pageNumber: 2 },
    { id: 'solenoide', text: 'O campo magnetico no interior de um solenoide e aproximadamente uniforme.', pageNumber: 3 },
];

/** Answers text and image queries with vectors the test chooses. */
function steered(pickedText: string): {
    provider: EmbeddingProvider;
    textQueries: string[];
    imageQueries: PageImage[];
} {
    const textQueries: string[] = [];
    const imageQueries: PageImage[] = [];
    const base = deterministicProvider(DIMENSIONS);
    // A document vector that points at `pickedText` and away from the rest,
    // so the winner is chosen by the test rather than by a hash.
    const toward = (text: string): number[] =>
        Array.from({ length: DIMENSIONS }, (_, i) => (text.includes(pickedText) ? (i === 0 ? 1 : 0) : i === 1 ? 1 : 0));

    return {
        provider: {
            ...base,
            modalities: ['text', 'image'],
            async embedDocuments(texts) {
                return texts.map(toward);
            },
            async embedQuery(text) {
                textQueries.push(text);
                return Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
            },
            async embedImageQuery(image) {
                imageQueries.push(image);
                return Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
            },
        },
        textQueries,
        imageQueries,
    };
}

describe('isImageQuery', () => {
    it('separates the two shapes and nothing else', () => {
        expect(isImageQuery(picture)).toBe(true);
        expect(isImageQuery('resistores em serie')).toBe(false);
        expect(isImageQuery('')).toBe(false);
    });
});

describe('an image query goes to the dense arm alone', () => {
    it('reaches embedImageQuery and never embedQuery', async () => {
        const { provider, textQueries, imageQueries } = steered('solenoide');
        const index = await createDenseIndex(CORPUS, provider, { tokenizer });

        await index.search(picture);

        expect(imageQueries).toEqual([picture]);
        expect(textQueries).toEqual([]);
    });

    it('a text query still reaches embedQuery and never the image path', async () => {
        const { provider, textQueries, imageQueries } = steered('solenoide');
        const index = await createDenseIndex(CORPUS, provider, { tokenizer });

        await index.search('campo magnetico');

        expect(textQueries).toEqual(['campo magnetico']);
        expect(imageQueries).toEqual([]);
    });

    it('the result is ordered by the dense arm, with nothing penalised for an empty lexical list', async () => {
        // Every candidate is missing from the lexical list, so the absence is
        // uniform: it cannot reorder anything. Each carries one contribution,
        // and the ordering is the dense ordering.
        const { provider } = steered('solenoide');
        const index = await createDenseIndex(CORPUS, provider, { tokenizer });

        const results = await index.search(picture);

        expect(results.length).toBeGreaterThan(0);
        expect(results[0]!.chunk.documentId).toBe('solenoide');
        // One arm, first place: 1/(k+1) with the default k of 60.
        expect(results[0]!.score).toBeCloseTo(1 / 61, 9);
    });

    it('is refused by a provider that cannot embed an image, and the message says what to change', async () => {
        const textOnly = deterministicProvider(DIMENSIONS);
        const index = await createDenseIndex(CORPUS, textOnly, { tokenizer });

        await expect(index.search(picture)).rejects.toThrow(/cannot embed an image query/u);
        await expect(index.search(picture)).rejects.toThrow(/embedImageQuery/u);
    });

    it('a provider that declares the modality but implements no query method is still refused', async () => {
        // `embedImages` and `embedImageQuery` are separate methods, and an
        // adapter can ship one without the other. The refusal names the one
        // that is missing rather than the capability in general.
        const halfway: EmbeddingProvider = {
            ...deterministicProvider(DIMENSIONS),
            modalities: ['text', 'image'],
            embedImages: vi.fn(async () => []),
        };
        const index = await createDenseIndex(CORPUS, halfway, { tokenizer });
        await expect(index.search(picture)).rejects.toThrow(/embedImageQuery/u);
        expect(halfway.embedImages).not.toHaveBeenCalled();
    });
});
