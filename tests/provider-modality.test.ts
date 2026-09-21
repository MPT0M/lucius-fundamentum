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
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Every provider this package builds, with the adapter family each comes
 * from — `family` is what the directory check counts, so a new adapter that
 * never reaches this list is caught there rather than passing unasked.
 *
 * `deterministic` is not an adapter, and `embedding.ts` says so; it is here
 * because it is a provider the package ships and the rule applies to it too.
 */
const FIXTURES: readonly { family: string; provider: EmbeddingProvider }[] = [
    { family: 'gemini', provider: geminiProvider({ apiKey: 'k' }) },
    { family: 'gemini', provider: geminiProvider({ apiKey: 'k', model: 'gemini-embedding-001' }) },
    { family: 'openai', provider: openAiProvider({ apiKey: 'k' }) },
    { family: 'qwen', provider: qwenProvider({ apiKey: 'k' }) },
    { family: 'deterministic', provider: deterministicProvider() },
];

describe('what each adapter declares', () => {
    it('the Gemini adapter claims image only for the model that was measured accepting one', () => {
        expect(geminiProvider({ apiKey: 'k' }).modalities).toEqual(['text', 'image']);
        expect(geminiProvider({ apiKey: 'k', model: 'gemini-embedding-2' }).modalities).toEqual(['text', 'image']);
        // Not measured, so not claimed. A claim here would make the guard wave
        // through a call that then fails at the provider.
        expect(geminiProvider({ apiKey: 'k', model: 'gemini-embedding-001' }).modalities).toEqual(['text']);
        expect(geminiProvider({ apiKey: 'k', model: 'something-new' }).modalities).toEqual(['text']);
    });

    it('the list under test is every adapter in the directory, not a list somebody remembered', () => {
        // The assertion below says "every adapter this package ships", and
        // the docblocks it answers to say the same. A hand-written list makes
        // that sentence true only until the next adapter lands, and the
        // failure is silence: the new one is simply never asked.
        //
        // `scaffold.test.ts` already reads a directory rather than trusting
        // a list; this is the same idiom. `http.ts` is the shared transport,
        // not an adapter — `embedding.ts` says the same about
        // `deterministicProvider`, which is in the fixtures below for
        // coverage rather than as an adapter.
        const inDirectory = readdirSync(join(process.cwd(), 'src', 'providers'))
            .filter((f) => f.endsWith('.ts') && f !== 'http.ts')
            .map((f) => f.replace(/\.ts$/u, ''))
            .sort();
        const covered = new Set(FIXTURES.map((f) => f.family));

        // The direction that matters: the directory is the source of truth
        // for what MUST be covered, and the fixtures may carry more — the
        // deterministic provider is not in that directory and is tested
        // anyway. Asserting the counts match would fail for that reason and
        // teach the next reader to delete coverage.
        expect(inDirectory.filter((name) => !covered.has(name))).toEqual([]);
        expect(inDirectory.length).toBeGreaterThan(0);
    });

    it('the method and the claim cannot disagree, for every adapter shipped here', () => {
        // Two docblocks say this equivalence is held by a test —
        // `EmbeddingProvider.embedImages` states the rule, and the Gemini
        // adapter points at it. Until this assertion existed, both were
        // describing an instrument that did not exist. The property was
        // true, and nothing would have caught it becoming false.
        for (const { family, provider } of FIXTURES) {
            const claims = provider.modalities.includes('image');
            expect(provider.embedImages !== undefined, `${family}: embedImages`).toBe(claims);
            expect(provider.embedImageQuery !== undefined, `${family}: embedImageQuery`).toBe(claims);
        }
        // Non-vacuity: the list must contain at least one of each side, or it
        // would pass on a list where the question never arises.
        expect(FIXTURES.some((f) => f.provider.modalities.includes('image'))).toBe(true);
        expect(FIXTURES.some((f) => !f.provider.modalities.includes('image'))).toBe(true);
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
