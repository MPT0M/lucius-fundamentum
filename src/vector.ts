/**
 * @fileoverview Vector arithmetic and the wire format for stored embeddings.
 *
 * Knows nothing about embedding providers, chunks or search. It normalizes,
 * compares and serializes float vectors, and that is all — the dense arm
 * builds on top of it and the tests here need no network and no provider.
 */

/**
 * The magnitude below which a vector counts as having no direction.
 *
 * Not zero: a vector of 1e-30 components is arithmetically non-zero and still
 * has no usable direction — normalizing it amplifies floating-point noise into
 * a unit vector pointing nowhere in particular, and that vector then scores
 * against everything. The threshold is well under any magnitude a real
 * embedding produces and well over the noise floor.
 */
const MINIMUM_NORM = 1e-12;

/** Euclidean length. */
export function norm(v: readonly number[]): number {
    let sum = 0;
    for (const x of v) sum += x * x;
    return Math.sqrt(sum);
}

/**
 * Scales a vector to unit length.
 *
 * Vectors are normalized once, at indexing time, so that cosine similarity
 * becomes a plain dot product at query time — the same number, without a
 * square root per chunk on the hot path. The query vector is normalized too:
 * without that the ordering would still be right, but the score would stop
 * being a cosine and stop being comparable across queries, and a score whose
 * meaning nobody knows is an invitation to become a threshold.
 *
 * Throws on a vector with no direction rather than returning zeros, because a
 * zero vector silently scores 0 against everything and looks like "no match"
 * instead of "the provider returned something unusable".
 */
export function normalize(v: readonly number[]): number[] {
    const length = norm(v);
    if (!Number.isFinite(length)) {
        throw new Error(`normalize: vector norm is ${length}, which means the vector holds NaN or Infinity`);
    }
    if (length < MINIMUM_NORM) {
        throw new Error(
            `normalize: vector norm is ${length}, below ${MINIMUM_NORM}; a vector with no direction cannot be a unit vector`,
        );
    }
    const out = new Array<number>(v.length);
    for (let i = 0; i < v.length; i += 1) out[i] = v[i]! / length;
    return out;
}

/**
 * Dot product, which equals cosine similarity when both vectors are unit
 * length — the reason indexing normalizes.
 */
export function dot(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length) {
        throw new Error(`dot: dimension mismatch, ${a.length} against ${b.length}`);
    }
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
    return sum;
}

/**
 * Packs vectors into the artifact's `dense.vectors` field: base64 of the
 * concatenated 32-bit floats, in chunk order.
 *
 * Byte order is pinned LITTLE-ENDIAN and written through a DataView rather
 * than handed to `Float32Array`'s own buffer. `Float32Array` uses the
 * platform's byte order, so an artifact packed on one machine and read on
 * another of opposite endianness would decode to noise — no error, no symptom,
 * just similarity scores that mean nothing. The artifact is a file that
 * travels; it does not get to depend on the machine that wrote it.
 *
 * Float32 and not Float64 halves the file for a precision loss that cosine on
 * unit vectors does not notice: the values live in [-1, 1], where float32
 * carries about seven significant digits.
 */
export function packVectors(vectors: readonly (readonly number[])[]): string {
    if (vectors.length === 0) return '';
    const dimensions = vectors[0]!.length;
    const bytes = new Uint8Array(vectors.length * dimensions * 4);
    const view = new DataView(bytes.buffer);

    let offset = 0;
    for (const v of vectors) {
        if (v.length !== dimensions) {
            throw new Error(`packVectors: vector of ${v.length} dimensions among vectors of ${dimensions}`);
        }
        for (const x of v) {
            view.setFloat32(offset, x, true);
            offset += 4;
        }
    }
    return base64FromBytes(bytes);
}

/** Reverses `packVectors`, given the dimension count the artifact declares. */
export function unpackVectors(packed: string, dimensions: number): number[][] {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
        throw new Error(`unpackVectors: dimensions must be a positive integer, received ${dimensions}`);
    }
    if (packed === '') return [];

    const bytes = bytesFromBase64(packed);
    const stride = dimensions * 4;
    if (bytes.length % stride !== 0) {
        throw new Error(
            `unpackVectors: ${bytes.length} bytes do not divide into vectors of ${dimensions} dimensions (${stride} bytes each)`,
        );
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out: number[][] = [];
    for (let start = 0; start < bytes.length; start += stride) {
        const v = new Array<number>(dimensions);
        for (let i = 0; i < dimensions; i += 1) v[i] = view.getFloat32(start + i * 4, true);
        out.push(v);
    }
    return out;
}

/**
 * Base64 without `Buffer` and without `btoa`.
 *
 * `Buffer` is Node-only and this library has to run in a Worker; `btoa` takes
 * a binary string, which means building a megabyte-long string one character
 * at a time before encoding it. Both work and neither is portable and cheap at
 * once, so the table is here.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64FromBytes(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i]!;
        const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
        const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
        out += ALPHABET[a >> 2];
        out += ALPHABET[((a & 0x03) << 4) | (b >> 4)];
        out += i + 1 < bytes.length ? ALPHABET[((b & 0x0f) << 2) | (c >> 6)] : '=';
        out += i + 2 < bytes.length ? ALPHABET[c & 0x3f] : '=';
    }
    return out;
}

const REVERSE: ReadonlyMap<string, number> = new Map([...ALPHABET].map((ch, i) => [ch, i]));

function bytesFromBase64(text: string): Uint8Array {
    const clean = text.replace(/=+$/u, '');

    // The empty string is a legitimate empty corpus and decodes to no bytes.
    // A payload that is ONLY padding, or that leaves one symbol over, is not:
    // six bits do not make a byte, and RFC 4648 has no such encoding. Both used
    // to fall through to zero bytes and read as "an index with no chunks",
    // which is the worst way for a corrupt artifact to present itself — it
    // looks like an empty corpus instead of a broken file.
    if (text.length > 0 && clean.length === 0) {
        throw new Error('unpackVectors: payload is nothing but padding');
    }
    if (clean.length % 4 === 1) {
        throw new Error(
            `unpackVectors: payload has ${clean.length} base64 symbols, which leaves one over; ` +
                'six bits do not encode a byte',
        );
    }

    for (const ch of clean) {
        if (!REVERSE.has(ch)) throw new Error(`unpackVectors: "${ch}" is not a base64 character`);
    }

    const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let byte = 0;
    let acc = 0;
    let bits = 0;
    for (const ch of clean) {
        acc = (acc << 6) | REVERSE.get(ch)!;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes[byte] = (acc >> bits) & 0xff;
            byte += 1;
        }
    }
    return bytes;
}
