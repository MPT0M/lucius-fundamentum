/**
 * The reference for composing a source list, and the replacement for the
 * footer this package used to compile.
 *
 * It lives as a test rather than as prose in `README.md` or a file under
 * `docs/` for one reason: nothing compiles or runs those. An example that
 * nothing runs rots at the first signature change, and it would have rotted
 * inside the very batch that wrote it. Here the typecheck compiles it, the
 * suite executes it, and a change to `FormattedAttribution` fails loudly.
 *
 * The package does not build this list itself because it cannot: a good line
 * needs the document's name, its page, its URL — all of which live in the
 * caller's registry, not in anything a `SourceDoc` carries. The one step that
 * is not obvious is that a span names the PASSAGE (`chunkId`), while the
 * marker shows a POSITION in `sources`, so turning one into the other is a
 * lookup.
 */
import { describe, it, expect } from 'vitest';
import {
    createIndex,
    createTokenizer,
    attributeLexical,
    formatAttribution,
    type SourceDoc,
    type SearchResult,
    type FormattedAttribution,
} from '../src/index.js';

const DOCS: readonly SourceDoc[] = [
    {
        id: 'lei-14133',
        text:
            'O prazo para recurso é de quinze dias corridos. ' +
            'A contagem exclui o dia do começo e inclui o do vencimento.',
    },
    { id: 'decreto-11246', text: 'A autoridade competente decide o recurso em dez dias.' },
];

/** What the caller knows and the package does not. */
const REGISTRY: Record<string, { readonly label: string; readonly url: string }> = {
    'lei-14133': { label: 'Lei 14.133/2021', url: 'https://example.org/lei-14133' },
    'decreto-11246': { label: 'Decreto 11.246/2022', url: 'https://example.org/decreto-11246' },
};

const tokenizer = createTokenizer();

function search(query: string): readonly SearchResult[] {
    const index = createIndex(DOCS, {
        tokenizer,
        chunkOptions: { maxChunkCodePoints: 80, maxOverlapCodePoints: 40 },
    });
    return index.searchLexical(query, { topK: 6 });
}

/**
 * The ten lines. Walks the cited spans, resolves each passage to its number,
 * and pairs it with the caller's own record.
 */
function sourceList(formatted: FormattedAttribution): string[] {
    const numbers = new Map<number, string>();
    for (const span of formatted.spans) {
        const index = formatted.sources.findIndex((r) => r.chunk.id === span.chunkId);
        if (index < 0) continue;
        const entry = REGISTRY[span.documentId];
        numbers.set(index, entry === undefined ? span.documentId : `${entry.label} — ${entry.url}`);
    }
    return [...numbers.entries()].sort((a, b) => a[0] - b[0]).map(([i, line]) => `[${i + 1}] ${line}`);
}

const ANSWER = 'O prazo para recurso é de quinze dias corridos.';

describe('composing a source list from the returned data', () => {
    it('lists only the passages that were cited, numbered as the markers are', () => {
        const results = search('prazo recurso quinze dias');
        const formatted = formatAttribution(attributeLexical(ANSWER, results, { tokenizer }), {
            markerStyle: 'bracket',
        });

        const list = sourceList(formatted);
        // One passage supports this answer, so one line — not one line per
        // search result, which is what a list built from `sources` would give.
        expect(list).toHaveLength(1);
        expect(results.length).toBeGreaterThan(1);
        expect(list[0]).toContain('Lei 14.133/2021 — https://example.org/lei-14133');
        // The number in the list is the number in the text, which is the whole
        // point of resolving through `sources` instead of counting spans.
        const number = list[0]!.slice(0, list[0]!.indexOf(']') + 1);
        expect(formatted.text).toContain(number);
    });

    it('works in the voice case, where the text carries no marker at all', () => {
        const results = search('prazo recurso quinze dias');
        const formatted = formatAttribution(attributeLexical(ANSWER, results, { tokenizer }), {
            markerStyle: 'none',
        });

        expect(formatted.text).toBe(ANSWER);
        expect(sourceList(formatted)).toHaveLength(1);
        expect(sourceList(formatted)[0]).toContain('Lei 14.133/2021');
    });

    it('falls back to the document id when the caller has no record for it', () => {
        const results = search('prazo recurso quinze dias');
        const formatted = formatAttribution(attributeLexical(ANSWER, results, { tokenizer }), {
            markerStyle: 'bracket',
        });
        const unknown: FormattedAttribution = {
            ...formatted,
            spans: formatted.spans.map((s) => ({ ...s, documentId: 'nao-registrado' })),
        };
        expect(sourceList(unknown)[0]).toContain('nao-registrado');
    });
});
