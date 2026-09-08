import { describe, it, expect } from 'vitest';
import { labelMatchesResponse, validateLabeledFixture, validateManifest, type Manifest, type ManifestEntry } from './manifest.js';
import type { GoogleRawFixture } from './fixture.js';
import type { LabeledFixture } from './score.js';

const LICENSES = ['public-domain-law'] as const;
const LABELERS = ['MPT0M'] as const;

const SOURCE: ManifestEntry = {
    id: 'lei-1',
    path: 'corpus/public/lei-1.txt',
    kind: 'source',
    license: 'public-domain-law',
    sourceUrl: 'https://example.invalid/lei-1',
    collectedAt: '2026-09-08',
};

function derived(id: string, derivedFrom: readonly string[] = ['lei-1'], path = `fixtures/google/${id}.json`): ManifestEntry {
    return {
        id,
        path,
        kind: 'derived',
        derivedFrom,
        model: 'm',
        recordedAt: '2026-09-08',
        reportVersion: 'v',
        storeEmbeddingModel: 'e',
        storeChunking: { maxTokensPerChunk: 100, maxOverlapTokens: 10 },
    };
}

function manifest(...entries: ManifestEntry[]): Manifest {
    return { entries };
}

const pathsOf = (m: Manifest) => m.entries.map((e) => e.path);

describe('validateManifest — presence', () => {
    it('a manifest whose entries and files agree has no problems', () => {
        const m = manifest(SOURCE, derived('r1'), derived('labeled-r1', ['lei-1'], 'fixtures/labeled/r1.json'));
        expect(validateManifest(m, pathsOf(m), LICENSES)).toEqual([]);
    });

    it('a file with no entry is named, and an entry with no file is named', () => {
        const m = manifest(SOURCE);
        expect(validateManifest(m, [...pathsOf(m), 'corpus/public/stray.txt'], LICENSES)).toEqual([
            'file "corpus/public/stray.txt" has no manifest entry',
        ]);
        expect(validateManifest(m, [], LICENSES)).toEqual(['entry "lei-1" points at "corpus/public/lei-1.txt", which does not exist']);
    });

    it('a repeated id is a problem: the id is the identity the emitter is matched by', () => {
        const m = manifest(SOURCE, { ...SOURCE, path: 'corpus/public/other.txt' });
        expect(validateManifest(m, pathsOf(m), LICENSES)).toEqual(['id "lei-1" appears more than once']);
    });

    it('a path declared by two entries is a problem: two ids for one file is two identities for one document', () => {
        const m = manifest(SOURCE, { ...SOURCE, id: 'lei-1-again' });
        expect(validateManifest(m, pathsOf(m), LICENSES)).toEqual(['path "corpus/public/lei-1.txt" is declared by more than one entry']);
    });
});

describe('validateManifest — the license rule', () => {
    it('a source with a license outside the allowlist is refused by value, however honestly declared', () => {
        const wiki: ManifestEntry = { ...SOURCE, id: 'wiki', path: 'corpus/public/wiki.txt', license: 'CC-BY-SA-4.0' };
        const m = manifest(wiki);
        expect(validateManifest(m, pathsOf(m), LICENSES)).toEqual(['source "wiki" carries license "CC-BY-SA-4.0", which is not allowed']);
    });

    it('a source that declares derivedFrom is refused: provenance flows from source to derived, never into a source', () => {
        const withDerivedFrom = { ...SOURCE, derivedFrom: ['lei-1'] } as unknown as ManifestEntry;
        const m = manifest(withDerivedFrom);
        expect(validateManifest(m, pathsOf(m), LICENSES)).toEqual(['source "lei-1" must not declare derivedFrom']);
    });

    it('a derived entry must not declare a license and must name at least one existing source', () => {
        const withLicense = { ...derived('r1'), license: 'public-domain-law' } as unknown as ManifestEntry;
        const orphan = derived('r2', []);
        const dangling = derived('r3', ['nope']);
        const fromDerived = derived('r4', ['r1']);
        const m = manifest(SOURCE, withLicense, orphan, dangling, fromDerived);
        expect(validateManifest(m, pathsOf(m), LICENSES)).toEqual([
            "derived \"r1\" must not declare a license: it inherits the origin's",
            'derived "r2" names no source',
            'derived "r3" names "nope", which is not in the manifest',
            'derived "r4" names "r1", which is not a source',
        ]);
    });
});

describe('validateManifest — a label and its response agree', () => {
    it('a label whose response is missing, or whose derivedFrom differs, is named', () => {
        const other: ManifestEntry = { ...SOURCE, id: 'lei-2', path: 'corpus/public/lei-2.txt' };
        const m = manifest(SOURCE, other, derived('r1', ['lei-1']), derived('labeled-r1', ['lei-2'], 'fixtures/labeled/r1.json'), derived('labeled-r9', ['lei-1'], 'fixtures/labeled/r9.json'));
        expect(validateManifest(m, pathsOf(m), LICENSES)).toEqual([
            'label "labeled-r1" and response "r1" disagree on derivedFrom',
            'label "labeled-r9" has no recorded response "r9"',
        ]);
    });

    it('derivedFrom is compared as a set: order does not matter', () => {
        const other: ManifestEntry = { ...SOURCE, id: 'lei-2', path: 'corpus/public/lei-2.txt' };
        const m = manifest(SOURCE, other, derived('r1', ['lei-1', 'lei-2']), derived('labeled-r1', ['lei-2', 'lei-1'], 'fixtures/labeled/r1.json'));
        expect(validateManifest(m, pathsOf(m), LICENSES)).toEqual([]);
    });
});

describe('validateLabeledFixture — what the scorer assumes is checked, not trusted', () => {
    const label = (segments: LabeledFixture['segments'], labeledBy = 'MPT0M'): LabeledFixture => ({
        id: 'r1',
        parts: [{ text: 'Frase um. Frase dois.' }],
        segments,
        labeledBy,
        labeledAt: '2026-09-08',
    });
    const seg = (start: number, end: number, partIndex = 0, documentId = 'lei-1') => ({
        partIndex,
        textSpan: { start, end },
        sourceSpans: [{ documentId, span: { start: 0, end: 5 } }],
    });

    it('a well-formed label has no problems', () => {
        expect(validateLabeledFixture(label([seg(0, 9), seg(10, 21)]), ['lei-1'], LABELERS)).toEqual([]);
    });

    it('a signer outside the allowlist is refused', () => {
        expect(validateLabeledFixture(label([seg(0, 9)], 'someone'), ['lei-1'], LABELERS)).toEqual([
            'label "r1" is signed by "someone", who is not in the allowlist',
        ]);
    });

    it('an empty or inverted span is refused, in the text and in the source', () => {
        const bad = label([{
            partIndex: 0,
            textSpan: { start: 5, end: 5 },
            sourceSpans: [{ documentId: 'lei-1', span: { start: 3, end: 2 } }, { documentId: 'lei-1', span: { start: 4, end: 4 } }],
        }]);
        expect(validateLabeledFixture(bad, ['lei-1'], LABELERS)).toEqual([
            'label "r1", segment 0 has an empty or inverted textSpan [5, 5)',
            'label "r1", segment 0, sourceSpan 0 has an empty or inverted span [3, 2)',
            'label "r1", segment 0, sourceSpan 1 has an empty or inverted span [4, 4)',
        ]);
    });

    it('segments of one Part must be disjoint and in order; another Part is a separate line', () => {
        const overlapping = label([seg(0, 9), seg(8, 21)]);
        expect(validateLabeledFixture(overlapping, ['lei-1'], LABELERS)).toEqual([
            'label "r1", segment 1 starts at 8, before the previous segment of Part 0 ends at 9: segments must be disjoint and in order',
        ]);
        const outOfOrder = label([seg(10, 21), seg(0, 9)]);
        expect(validateLabeledFixture(outOfOrder, ['lei-1'], LABELERS)).toEqual([
            'label "r1", segment 1 starts at 0, before the previous segment of Part 0 ends at 21: segments must be disjoint and in order',
        ]);
        const touching = label([seg(0, 9), seg(9, 21)]);
        expect(validateLabeledFixture(touching, ['lei-1'], LABELERS)).toEqual([]);

        // A second Part starts its own line: its first segment may begin at 0 after Part 0 ended at 21.
        const twoParts: LabeledFixture = { ...label([seg(10, 21, 0), seg(0, 9, 1)]), parts: [{ text: 'Frase um. Frase dois.' }, { text: 'Parte dois.' }] };
        expect(validateLabeledFixture(twoParts, ['lei-1'], LABELERS)).toEqual([]);
    });

    it('a Part that does not exist — above the last or negative — and a document outside derivedFrom are named', () => {
        const bad = label([seg(0, 9, 3, 'lei-9')]);
        expect(validateLabeledFixture(bad, ['lei-1'], LABELERS)).toEqual([
            'label "r1", segment 0 names Part 3, which does not exist',
            "label \"r1\", segment 0, sourceSpan 0 names \"lei-9\", which is not in the entry's derivedFrom",
        ]);
        expect(validateLabeledFixture(label([seg(0, 9, -1)]), ['lei-1'], LABELERS)).toEqual(['label "r1", segment 0 names Part -1, which does not exist']);
    });

    it('a segment with no source span is not a supported stretch and is refused', () => {
        const bad = label([{ partIndex: 0, textSpan: { start: 0, end: 9 }, sourceSpans: [] }]);
        expect(validateLabeledFixture(bad, ['lei-1'], LABELERS)).toEqual(['label "r1", segment 0 has no sourceSpans']);
    });
});

describe('labelMatchesResponse — a label is a transcript of one recorded response', () => {
    const raw: GoogleRawFixture = {
        id: 'r1',
        model: 'm',
        recordedAt: '2026-09-08',
        reportVersion: 'v',
        storeEmbeddingModel: 'e',
        storeChunking: { maxTokensPerChunk: 100, maxOverlapTokens: 10 },
        parts: [{ text: 'Frase um.' }, { text: 'Parte dois.' }],
        usageMetadata: {},
    };
    // A separate literal with the same text: a comparison by reference must not pass here.
    const labeled: LabeledFixture = { id: 'r1', parts: [{ text: 'Frase um.' }, { text: 'Parte dois.' }], segments: [], labeledBy: 'MPT0M', labeledAt: '2026-09-08' };

    it('the same id and the same parts, text by text, is a match', () => {
        expect(labelMatchesResponse(labeled, raw)).toEqual([]);
    });

    it('a different id, a different Part text, or a different number of Parts is named', () => {
        expect(labelMatchesResponse({ ...labeled, id: 'r2' }, raw)).toEqual(['label "r2" is filed against response "r1"']);
        expect(labelMatchesResponse({ ...labeled, parts: [{ text: 'Frase um.' }, { text: 'Parte DOIS.' }] }, raw)).toEqual(['label "r1" carries parts that differ from the recorded response']);
        expect(labelMatchesResponse({ ...labeled, parts: [{ text: 'Frase um.' }] }, raw)).toEqual(['label "r1" carries parts that differ from the recorded response']);
    });
});
