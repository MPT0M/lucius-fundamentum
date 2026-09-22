/**
 * The extractor, and it is deliberately OUTSIDE the library.
 *
 * **This file is the lesson.** The package never opens a binary: it receives
 * text that is already text and an image that is already raster. Everything
 * between a PDF on disk and that input is the caller's, and the commonest
 * wrong expectation about this package is that it eats PDFs. Showing the
 * extractor here, in the example, teaches the boundary better than a paragraph
 * of README can.
 *
 * pdf.js comes from a CDN and is pinned to an exact version. Two consequences,
 * both real: a bench with no network cannot open a PDF, and a URL is the
 * weakest pin there is — nothing here verifies what came back. That is
 * acceptable for an example and would not be for a product, which is the kind
 * of difference an example should be honest about rather than hide.
 *
 * On licensing: pdf.js is Apache-2.0, and this repository takes §4(d)
 * attribution seriously enough to keep a `NOTICE` and a test pinning it. The
 * obligation is on REDISTRIBUTION, and `files: ["dist", "NOTICE"]` means
 * `examples/` never enters the tarball — the bench points at a CDN and
 * redistributes nothing. Saying so here so the next person neither copies a
 * `NOTICE` that is not needed nor concludes the house stopped caring.
 */

const PDFJS_VERSION = '6.3.289';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;

/**
 * Rendered page width, in CSS pixels, before the device ratio.
 *
 * It is the one knob that trades legibility against memory: a 40-page PDF held
 * at print resolution is hundreds of megabytes of canvas in a tab.
 */
const RENDER_WIDTH = 1100;

/** @type {Promise<any> | null} */
let loading = null;

/**
 * Loads pdf.js once, on the first PDF and never before.
 *
 * The specifier is a variable rather than a literal so that the type-checker
 * leaves it alone: it cannot resolve a URL, and a literal here would be an
 * unresolved-module error on a dependency that is deliberately not installed.
 * The cost of that choice is stated rather than hidden — what comes back is
 * `any`, so nothing below this line is type-checked against pdf.js's real
 * shape.
 *
 * @returns {Promise<any>}
 */
function loadPdfjs() {
    if (loading === null) {
        const url = `${PDFJS_BASE}/pdf.mjs`;
        loading = import(url).then((mod) => {
            // The worker has to be told where it lives when the library is
            // loaded cross-origin; without this it looks beside the page and
            // 404s, and the failure surfaces as a document that never resolves.
            mod.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.mjs`;
            return mod;
        });
    }
    return loading;
}

/**
 * Every page of a PDF, as text and as an image.
 *
 * Both, for every page, always — the bench keeps the image whether or not the
 * library ever sees it, because the viewer needs a page for any hit, including
 * hits on pages whose text was perfectly good.
 *
 * The text is joined with spaces between items rather than concatenated. pdf.js
 * returns positioned fragments, not a sentence, and gluing them produces words
 * welded to their neighbours — which the tokenizer would then index as one
 * term that matches nothing anybody types.
 *
 * @param {ArrayBuffer} bytes
 * @returns {Promise<{ pageNumber: number, text: string, image: import('../../dist/index.js').PageImage }[]>}
 */
export async function readPdf(bytes) {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: bytes }).promise;

    /** @type {{ pageNumber: number, text: string, image: import('../../dist/index.js').PageImage }[]} */
    const pages = [];

    for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);

        const content = await page.getTextContent();
        const text = content.items
            .map((/** @type {{ str?: string }} */ item) => item.str ?? '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

        pages.push({ pageNumber: n, text, image: await rasterize(page) });
    }

    return pages;
}

/**
 * One page as PNG bytes, base64-encoded the way `PageImage` wants them.
 *
 * @param {any} page a pdf.js page
 * @returns {Promise<import('../../dist/index.js').PageImage>}
 */
async function rasterize(page) {
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: RENDER_WIDTH / unscaled.width });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const context = canvas.getContext('2d');
    if (context === null) throw new Error('this browser gave no 2d canvas context');
    await page.render({ canvasContext: context, viewport }).promise;

    const blob = await new Promise((/** @type {(b: Blob | null) => void} */ resolve) =>
        canvas.toBlob(resolve, 'image/png'),
    );
    if (blob === null) throw new Error('the page could not be encoded as PNG');

    return { data: await toBase64(blob), mimeType: 'image/png' };
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
async function toBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Chunked rather than one spread, because `String.fromCharCode(...bytes)`
    // on a megabyte-sized page overflows the argument limit and throws — a
    // failure that only appears on large pages, which is the worst kind.
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}
