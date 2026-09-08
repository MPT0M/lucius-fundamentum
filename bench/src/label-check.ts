/**
 * Whether a hand-written label may be scored against the answer it claims to
 * transcribe. Pure, so the rule has a test even though the only caller is the
 * runner, which the suite never executes.
 *
 * Two families of problem, both already named by `manifest.ts`: the label
 * breaks an assumption the scorer makes (spans, order, Parts, signer), or the
 * label was written over a different answer than the one on disk (id or
 * parts differ). Either one makes the score a number nobody can trust, so the
 * caller refuses to score and names the problems instead.
 */

import type { GoogleRawFixture } from './fixture.js';
import { labelMatchesResponse, validateLabeledFixture } from './manifest.js';
import type { LabeledFixture } from './score.js';

export function checkLabel(
    labeled: LabeledFixture,
    fixture: GoogleRawFixture,
    derivedFrom: readonly string[],
    allowedLabelers: readonly string[],
): string[] {
    return [...validateLabeledFixture(labeled, derivedFrom, allowedLabelers), ...labelMatchesResponse(labeled, fixture)];
}
