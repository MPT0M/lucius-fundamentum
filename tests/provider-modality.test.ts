/**
 * An adapter declares what it can be asked to embed, and asking for anything
 * else is refused before the network.
 *
 * Two rules are held here and they fail differently. The DECLARATION is a
 * claim each adapter makes about the model it was configured with; getting it
 * wrong sends a request that the provider rejects, far from the choice that
 * caused it. The REFUSAL is what turns that into an error the caller can act
 * on, and it has to fire before anything is paid for.
 */
import { describe, expect, it } from 'vitest';
import {
    assertModalitySupported,
    deterministicProvider,
    EmbeddingCheckError,
    type EmbeddingProvider,
} from '../src/embedding.js';
import { geminiProvider } from '../src/providers/gemini.js';
import { openAiProvider } from '../src/providers/openai.js';
import { qwenProvider } from '../src/providers/qwen.js';

describe('what each adapter declares', () => {
    it('the Gemini adapter claims image only for the model that was measured accepting one', () => {
        expect(geminiProvider({ apiKey: 'k' }).modalities).toEqual(['text', 'image']);
        expect(geminiProvider({ apiKey: 'k', model: 'gemini-embedding-2' }).modalities).toEqual(['text', 'image']);
        // Not measured, so not claimed. A claim here would make the guard wave
        // through a call that then fails at the provider.
        expect(geminiProvider({ apiKey: 'k', model: 'gemini-embedding-001' }).modalities).toEqual(['text']);
        expect(geminiProvider({ apiKey: 'k', model: 'something-new' }).modalities).toEqual(['text']);
    });

    it('the adapters that speak text-only endpoints say so', () => {
        expect(openAiProvider({ apiKey: 'k' }).modalities).toEqual(['text']);
        expect(qwenProvider({ apiKey: 'k' }).modalities).toEqual(['text']);
        expect(deterministicProvider().modalities).toEqual(['text']);
    });
});

describe('the refusal', () => {
    const textOnly = deterministicProvider(4);

    it('names the provider, what it declares, and how much was asked of it', () => {
        try {
            assertModalitySupported('image', textOnly, 26);
            expect.unreachable('should have refused');
        } catch (error) {
            expect(error).toBeInstanceOf(EmbeddingCheckError);
            const check = error as EmbeddingCheckError;
            expect(check.reason).toBe('modality-unsupported');
            expect(check.message).toContain('deterministic-4');
            expect(check.message).toContain('[text]');
            expect(check.message).toContain('26 image inputs');
        }
    });

    it('says "input" and not "inputs" for one', () => {
        // The message is read by a person looking at a failed index run, and
        // "1 image inputs" reads like the count is wrong rather than the
        // configuration.
        expect(() => assertModalitySupported('image', textOnly, 1)).toThrow(/1 image input\b/u);
    });

    it('a declared modality passes', () => {
        const multimodal: EmbeddingProvider = { ...textOnly, modalities: ['text', 'image'] };
        expect(() => assertModalitySupported('image', multimodal, 3)).not.toThrow();
        expect(() => assertModalitySupported('text', multimodal, 3)).not.toThrow();
    });

    it('text is refused too, when an adapter somehow declares no text', () => {
        // Nothing ships like this, and the guard must not special-case text
        // into always passing: a rule with an exception nobody can reach is a
        // rule that stops being checked.
        const odd: EmbeddingProvider = { ...textOnly, modalities: ['image'] };
        expect(() => assertModalitySupported('text', odd, 2)).toThrow(/declares \[image\]/u);
    });
});
