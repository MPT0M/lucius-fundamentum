/**
 * The manifest is the one source of truth for provenance: every file under the
 * public corpus and under the fixtures has an entry, and every derived artifact
 * — a raw response recorded from the emitter, or its hand-written label — names
 * the source documents it was generated from.
 *
 * The rules live here as pure functions over the parsed manifest and the list
 * of files present, so that the disk test in `tests/` is thin and the same
 * rules are checked by unit tests with small hand-built manifests. The two
 * allowlists — which licenses a source may carry, who may sign a label — are
 * NOT here: they are declared in the disk test, where the owner adds to them.
 * A guard that lives in a comment is not a guard; one that lives in a test the
 * suite runs is.
 *
 * Why the license is on the source and inherited by the derived: a recorded
 * response contains verbatim text of the documents it cites, and a label is a
 * transcript of that response. Their obligations are the origin's. Declaring
 * a license again on the derived entry would let the two disagree.
 *
 * ASSUMED of the caller: the parsed JSON already has the shape of the types
 * below — `entries` is an array, every entry has string `id`, `path` and
 * `kind`, a derived entry has `derivedFrom`, a label has `parts` and
 * `segments`. The manifest is written by one hand and read by this suite; a
 * field missing from it fails the suite as a TypeError, loudly but without a
 * sentence. A shape parser with named problems arrives with the first entry.
 */

import type { GoogleRawFixture } from './fixture.js';
import type { LabeledFixture } from './score.js';

export interface SourceEntry {
    readonly id: string;
    /** Relative to `bench/`, POSIX separators. */
    readonly path: string;
    readonly kind: 'source';
    readonly license: string;
    readonly sourceUrl: string;
    readonly collectedAt: string;
}

export interface DerivedEntry {
    readonly id: string;
    /** Relative to `bench/`, POSIX separators. */
    readonly path: string;
    readonly kind: 'derived';
    /** Ids of `source` entries. Never empty. */
    readonly derivedFrom: readonly string[];
    readonly model: string;
    readonly recordedAt: string;
    readonly reportVersion: string;
    readonly storeEmbeddingModel: string;
    readonly storeChunking: { readonly maxTokensPerChunk: number; readonly maxOverlapTokens: number };
}

export type ManifestEntry = SourceEntry | DerivedEntry;

export interface Manifest {
    readonly entries: readonly ManifestEntry[];
}

/**
 * The label of a recorded response is filed under this prefix plus the
 * response's id. The prefix is a filing convention, not what decides whether
 * an entry is a label: the disk test decides that by the directory the file is
 * in, and refuses a file there whose id lacks the prefix.
 */
export const LABELED_PREFIX = 'labeled-';

/**
 * Checks the manifest against itself and against the files present. Every
 * problem is a sentence naming the entry or the file, so a failing test says
 * what to fix rather than that something is wrong.
 *
 * `presentPaths` are the files the disk test found under the governed
 * directories, relative to `bench/`, POSIX separators, with the files the
 * caller declared exempt already removed.
 */
export function validateManifest(
    manifest: Manifest,
    presentPaths: readonly string[],
    allowedLicenses: readonly string[],
): string[] {
    const problems: string[] = [];
    const byId = new Map<string, ManifestEntry>();
    const byPath = new Map<string, ManifestEntry>();

    for (const entry of manifest.entries) {
        if (byId.has(entry.id)) problems.push(`id "${entry.id}" appears more than once`);
        byId.set(entry.id, entry);
        if (byPath.has(entry.path)) problems.push(`path "${entry.path}" is declared by more than one entry`);
        byPath.set(entry.path, entry);
    }

    for (const path of presentPaths) {
        if (!byPath.has(path)) problems.push(`file "${path}" has no manifest entry`);
    }
    const present = new Set(presentPaths);
    for (const entry of manifest.entries) {
        if (!present.has(entry.path)) problems.push(`entry "${entry.id}" points at "${entry.path}", which does not exist`);
    }

    for (const entry of manifest.entries) {
        if (entry.kind === 'source') {
            if (!allowedLicenses.includes(entry.license)) {
                problems.push(`source "${entry.id}" carries license "${entry.license}", which is not allowed`);
            }
            if ('derivedFrom' in entry) problems.push(`source "${entry.id}" must not declare derivedFrom`);
            continue;
        }
        if ('license' in entry) problems.push(`derived "${entry.id}" must not declare a license: it inherits the origin's`);
        if (entry.derivedFrom.length === 0) problems.push(`derived "${entry.id}" names no source`);
        for (const sourceId of entry.derivedFrom) {
            const source = byId.get(sourceId);
            if (source === undefined) problems.push(`derived "${entry.id}" names "${sourceId}", which is not in the manifest`);
            else if (source.kind !== 'source') problems.push(`derived "${entry.id}" names "${sourceId}", which is not a source`);
        }
    }

    // A label and the response it labels must agree on where the text came from.
    for (const entry of manifest.entries) {
        if (entry.kind !== 'derived' || !entry.id.startsWith(LABELED_PREFIX)) continue;
        const rawId = entry.id.slice(LABELED_PREFIX.length);
        const raw = byId.get(rawId);
        if (raw === undefined) {
            problems.push(`label "${entry.id}" has no recorded response "${rawId}"`);
            continue;
        }
        if (raw.kind !== 'derived' || !sameSet(raw.derivedFrom, entry.derivedFrom)) {
            problems.push(`label "${entry.id}" and response "${rawId}" disagree on derivedFrom`);
        }
    }

    return problems;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    const sa = new Set(a);
    const sb = new Set(b);
    return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/**
 * Checks one label — the scorer's own `LabeledFixture`, read from disk —
 * against the rules the scorer assumes and the manifest entry it belongs to.
 * The scorer matches a marker to the segment of greatest intersection, which
 * is only well-defined if the segments of one Part are disjoint; the plan also
 * fixes them in order, so both are checked here rather than trusted.
 */
export function validateLabeledFixture(
    labeled: LabeledFixture,
    derivedFrom: readonly string[],
    allowedLabelers: readonly string[],
): string[] {
    const problems: string[] = [];
    const where = `label "${labeled.id}"`;

    if (!allowedLabelers.includes(labeled.labeledBy)) {
        problems.push(`${where} is signed by "${labeled.labeledBy}", who is not in the allowlist`);
    }

    const lastEndByPart = new Map<number, number>();
    labeled.segments.forEach((segment, i) => {
        const at = `${where}, segment ${i}`;
        if (segment.partIndex < 0 || segment.partIndex >= labeled.parts.length) {
            problems.push(`${at} names Part ${segment.partIndex}, which does not exist`);
        }
        const { start, end } = segment.textSpan;
        if (!(end > start)) problems.push(`${at} has an empty or inverted textSpan [${start}, ${end})`);
        const lastEnd = lastEndByPart.get(segment.partIndex);
        if (lastEnd !== undefined && start < lastEnd) {
            problems.push(`${at} starts at ${start}, before the previous segment of Part ${segment.partIndex} ends at ${lastEnd}: segments must be disjoint and in order`);
        }
        lastEndByPart.set(segment.partIndex, Math.max(lastEnd ?? 0, end));

        if (segment.sourceSpans.length === 0) problems.push(`${at} has no sourceSpans`);
        segment.sourceSpans.forEach((source, j) => {
            if (!derivedFrom.includes(source.documentId)) {
                problems.push(`${at}, sourceSpan ${j} names "${source.documentId}", which is not in the entry's derivedFrom`);
            }
            if (!(source.span.end > source.span.start)) {
                problems.push(`${at}, sourceSpan ${j} has an empty or inverted span [${source.span.start}, ${source.span.end})`);
            }
        });
    });

    return problems;
}

/**
 * A label is a transcript of one recorded response: its `id` is the
 * response's, and its `parts` are a literal copy of the Parts the emitter
 * generated. The scorer places every span against `parts`, so a copy that
 * drifted from the recording would be scored against the wrong text without a
 * word.
 */
export function labelMatchesResponse(labeled: LabeledFixture, raw: GoogleRawFixture): string[] {
    const problems: string[] = [];
    if (labeled.id !== raw.id) problems.push(`label "${labeled.id}" is filed against response "${raw.id}"`);
    const sameParts = labeled.parts.length === raw.parts.length && labeled.parts.every((p, i) => p.text === raw.parts[i]?.text);
    if (!sameParts) problems.push(`label "${labeled.id}" carries parts that differ from the recorded response`);
    return problems;
}
