/**
 * The two Gemini embedding generations are told which side of the pair they
 * are embedding in different ways, and the adapter has to know which.
 *
 * Nothing here errors when it is wrong. A prefix sent to the older model is
 * literal text it was never trained to strip; an absent `task_type` on that
 * model falls back to a default. Both degrade retrieval in silence, which is
 * why the branch is pinned by assertions on the request body rather than
 * left to a reviewer noticing.
 */
import { describe, expect, it, vi } from 'vitest';
import { geminiProvider } from '../src/providers/gemini.js';

describe('the two Gemini generations are told the task in different ways', () => {
    /** Captures the request body without a network. */
    function spy(): { calls: Record<string, unknown>[]; fetch: typeof globalThis.fetch } {
        const calls: Record<string, unknown>[] = [];
        const fetch = vi.fn(async (_url: unknown, init: unknown) => {
            calls.push(JSON.parse((init as { body: string }).body) as Record<string, unknown>);
            return new Response(JSON.stringify({ embedding: { values: Array(1536).fill(0.1) } }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
    }

    it('gemini-embedding-2 gets the prefix in the text and no task_type', async () => {
        const { calls, fetch } = spy();
        const provider = geminiProvider({ apiKey: 'k', model: 'gemini-embedding-2', fetch });
        await provider.embedQuery('resistores em serie');
        await provider.embedDocuments(['uma passagem']);

        expect(calls[0]!['task_type']).toBeUndefined();
        expect(textOf(calls[0]!)).toBe('task: search result | query: resistores em serie');
        expect(calls[1]!['task_type']).toBeUndefined();
        expect(textOf(calls[1]!)).toBe('title: none | text: uma passagem');
    });

    it('gemini-embedding-001 gets task_type and the text untouched', async () => {
        // Measured: on 001 the two task types produce different vectors
        // (cos 0.4067), and omitting the field falls back to RETRIEVAL_QUERY.
        // So a document sent with no task_type was embedded as a question.
        const { calls, fetch } = spy();
        const provider = geminiProvider({ apiKey: 'k', model: 'gemini-embedding-001', fetch });
        await provider.embedQuery('resistores em serie');
        await provider.embedDocuments(['uma passagem']);

        expect(calls[0]!['task_type']).toBe('RETRIEVAL_QUERY');
        expect(textOf(calls[0]!)).toBe('resistores em serie');
        expect(calls[1]!['task_type']).toBe('RETRIEVAL_DOCUMENT');
        expect(textOf(calls[1]!)).toBe('uma passagem');
    });

    it('the two sides are never sent the same way', async () => {
        // The whole reason the interface has two methods: an adapter that
        // collapsed them would still return vectors and still rank.
        for (const model of ['gemini-embedding-2', 'gemini-embedding-001']) {
            const { calls, fetch } = spy();
            const provider = geminiProvider({ apiKey: 'k', model, fetch });
            await provider.embedQuery('mesma frase');
            await provider.embedDocuments(['mesma frase']);
            expect(JSON.stringify(calls[0])).not.toBe(JSON.stringify(calls[1]));
        }
    });
});

function textOf(body: Record<string, unknown>): string {
    const content = body['content'] as { parts: { text: string }[] };
    return content.parts[0]!.text;
}
