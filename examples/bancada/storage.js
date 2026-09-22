/**
 * The cache, and it is IndexedDB rather than `localStorage` for a measured
 * reason.
 *
 * The repository's own public corpus — 7 documents, 636 chunks — serialises to
 * about 1.5 MB of lexical artifact, and a dense arm over the same corpus adds
 * roughly 5 MB more (that second figure is arithmetic, not a measurement:
 * chunks × dimensions × 4 bytes × 4/3 for base64). `localStorage` holds five to
 * ten megabytes of STRING across an entire origin, so it is the wrong shelf
 * before the first realistic corpus.
 *
 * Nothing here expires, and that is deliberate. This is a demo cache on the
 * person's own machine, holding material whose originals are already on their
 * disk. Real retention is a product problem with somebody else's documents in
 * it, and that belongs in a database rather than a browser.
 */

const DB_NAME = 'fundamentum-bench';
const STORE = 'cache';
const RECORD = 'current';

/** @returns {Promise<IDBDatabase>} */
function open() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function awaited(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * @typedef {object} Cached
 * @property {import('../../dist/index.js').IndexArtifact} artifact
 * @property {[string, import('../../dist/index.js').PageImage][]} pages
 * @property {number} savedAt epoch milliseconds
 */

/**
 * @param {import('../../dist/index.js').IndexArtifact} artifact
 * @param {Map<string, import('../../dist/index.js').PageImage>} pages
 * @returns {Promise<void>}
 */
export async function save(artifact, pages) {
    const db = await open();
    /** @type {Cached} */
    const record = { artifact, pages: [...pages], savedAt: Date.now() };
    const tx = db.transaction(STORE, 'readwrite');
    await awaited(tx.objectStore(STORE).put(record, RECORD));
    db.close();
}

/** @returns {Promise<Cached | null>} */
export async function load() {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');
    const record = /** @type {Cached | undefined} */ (await awaited(tx.objectStore(STORE).get(RECORD)));
    db.close();
    return record ?? null;
}

/** @returns {Promise<void>} */
export async function forget() {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    await awaited(tx.objectStore(STORE).delete(RECORD));
    db.close();
}

/**
 * Roughly how much of the machine this is occupying.
 *
 * `navigator.storage.estimate()` reports the whole origin rather than this
 * record, and it is approximate by specification — browsers round it to resist
 * fingerprinting. It is reported as approximate for that reason, not out of
 * caution: a bench that silently fills someone's disk is a bench that should
 * have said so.
 *
 * @returns {Promise<number | null>} bytes, or null where the API is absent
 */
export async function approximateBytes() {
    const estimate = await navigator.storage?.estimate?.();
    return estimate?.usage ?? null;
}
