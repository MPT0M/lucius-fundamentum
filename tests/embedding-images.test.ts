/**
 * `embedImagesChecked` has the same two guards as its text twin, and they are
 * here because copying a guard is not the same as having one.
 *
 * The text path has four tests for these; the image path had none until this
 * file. The failure they catch is the worst kind the package has: a provider
 * returning one vector fewer than it was given pages shifts every page's
 * vector onto its neighbour, and the index goes on working, ranking, and
 * being wrong everywhere.
 */
import { describe, expect, it } from 'vitest';
import {
    embedImagesChecked,
    deterministicProvider,
    EmbeddingCheckError,
    type EmbeddingProvider,
} from '../src/embedding.js';
import type { PageImage } from '../src/chunker.js';

const PAGES: readonly PageImage[] = [
    { data: 'UEFHSU5BLTE=', mimeType: 'image/png' },
    { data: 'UEFHSU5BLTI=', mimeType: 'image/jpeg' },
];

/** Declares the modality and answers with whatever the test dictates. */
const withImages = (
    embedImages: EmbeddingProvider['embedImages'],
): EmbeddingProvider => ({
    ...deterministicProvider(4),
    modalities: ['text', 'image'],
    ...(embedImages === undefined ? {} : { embedImages }),
});

describe('embedImagesChecked', () => {
    it('returns one unit-length vector per page, in order', async () => {
        const provider = withImages(async (images) => images.map((_, i) => [i + 1, 0, 0, 0]));
        const out = await embedImagesChecked(PAGES, provider);

        expect(out).toHaveLength(2);
        for (const vector of out) {
            const length = Math.hypot(...vector);
            expect(length).toBeCloseTo(1, 12);
        }
        // Normalised, not passed through: the raw vectors were [1,0,0,0] and
        // [2,0,0,0], which are not unit length and are not equal to each
        // other. After normalising both become [1,0,0,0], so the check that
        // the ORDER survived has to look at what went in, not at what came
        // back — hence the provider receiving the pages is asserted instead.
        const seen: PageImage[] = [];
        await embedImagesChecked(
            PAGES,
            withImages(async (images) => {
                seen.push(...images);
                return images.map(() => [1, 0, 0, 0]);
            }),
        );
        expect(seen).toEqual([...PAGES]);
    });

    it('refuses fewer vectors than pages, which would shift every later page', async () => {
        const short = withImages(async (images) => images.slice(1).map(() => [1, 0, 0, 0]));
        await expect(embedImagesChecked(PAGES, short)).rejects.toThrow(/exactly one per image/u);
        await expect(embedImagesChecked(PAGES, short)).rejects.toThrow(EmbeddingCheckError);
    });

    it('refuses more vectors than pages too', async () => {
        // The other direction of the same mistake. Nothing shifts, but the
        // caller would store a vector belonging to no chunk.
        const many = withImages(async (images) => [...images, images[0]!].map(() => [1, 0, 0, 0]));
        await expect(embedImagesChecked(PAGES, many)).rejects.toThrow(/3 vectors for 2 images/u);
    });

    it('refuses a vector of the wrong width, naming which page', async () => {
        const wrong = withImages(async (images) => images.map((_, i) => (i === 1 ? [1, 0] : [1, 0, 0, 0])));
        await expect(embedImagesChecked(PAGES, wrong)).rejects.toThrow(/2-dimension vector for image 1/u);
    });

    it('names the missing method rather than throwing a TypeError', async () => {
        const claims = withImages(undefined);
        await expect(embedImagesChecked(PAGES, claims)).rejects.toThrow(/implements no embedImages/u);
        await expect(embedImagesChecked(PAGES, claims)).rejects.toThrow(EmbeddingCheckError);
    });

    it('the reason is a field, so a caller classifies without reading prose', async () => {
        const short = withImages(async () => []);
        try {
            await embedImagesChecked(PAGES, short);
            expect.unreachable('should have refused');
        } catch (error) {
            expect((error as EmbeddingCheckError).reason).toBe('bad-count');
        }
    });
});
