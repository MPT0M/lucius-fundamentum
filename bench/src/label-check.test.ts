import { describe, it, expect } from 'vitest';
import { checkLabel } from './label-check.js';
import type { GoogleRawFixture } from './fixture.js';
import type { LabeledFixture } from './score.js';

const LABELERS = ['MPT0M'] as const;

const fixture: GoogleRawFixture = {
    id: 'q01-plain',
    model: 'm',
    recordedAt: '2026-09-08',
    reportVersion: 'v',
    storeEmbeddingModel: 'e',
    storeChunking: { maxTokensPerChunk: 200, maxOverlapTokens: 20 },
    parts: [{ text: 'Frase um. Frase dois.' }],
    usageMetadata: { toolUsePromptTokenCount: 1 },
};

const label: LabeledFixture = {
    id: 'q01-plain',
    parts: [{ text: 'Frase um. Frase dois.' }],
    segments: [{ partIndex: 0, textSpan: { start: 0, end: 9 }, sourceSpans: [{ documentId: 'machado', span: { start: 0, end: 5 } }] }],
    labeledBy: 'MPT0M',
    labeledAt: '2026-09-08',
};

describe('checkLabel — a label is scored only against the answer it transcribes', () => {
    it('a label that matches the recorded answer and the scorer’s assumptions has no problems', () => {
        expect(checkLabel(label, fixture, ['machado'], LABELERS)).toEqual([]);
    });

    it('a label whose parts diverged from the recorded answer is refused before scoring', () => {
        // The runner never re-asks a recorded question, so this is the second line of
        // defence: if that policy regresses, or someone edits a recorded answer by hand,
        // the label still describes the old text and this is what refuses it.
        const reasked: GoogleRawFixture = { ...fixture, parts: [{ text: 'Frase um. Frase DOIS.' }] };
        expect(checkLabel(label, reasked, ['machado'], LABELERS)).toEqual(['label "q01-plain" carries parts that differ from the recorded response']);
    });

    it('a label that breaks the scorer’s assumptions and names another answer reports both families, scorer first', () => {
        const bad: LabeledFixture = { ...label, id: 'q09-plain', labeledBy: 'someone' };
        expect(checkLabel(bad, fixture, ['machado'], LABELERS)).toEqual([
            'label "q09-plain" is signed by "someone", who is not in the allowlist',
            'label "q09-plain" is filed against response "q01-plain"',
        ]);
    });
});
