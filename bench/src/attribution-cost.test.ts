import { describe, it, expect } from 'vitest';
import { measure } from './attribution-cost.js';

describe('attribution-cost — the probe behind the single-event design', () => {
    it('pins the ORDER of the local work, never the decimal', () => {
        // The claim the design rests on is that one phase has duration a person
        // perceives and the rest does not. That claim survives any realistic
        // latency; a specific figure does not survive a different machine, or
        // even a busy one — this probe measured 4.3 and 3.1 ms alone and 7.8 and
        // 8.3 ms with the suite loading the machine from a second shell. The
        // 3.4 ms it was written to retract predates it and came from no
        // instrument at all. Pinning
        // the decimal would make this test fail for reasons that have nothing
        // to do with the package.
        const out = measure();

        // EXACT, for the same reason as the candidate count below: the
        // CHANGELOG publishes both figures, and both are deterministic — they
        // come from `repeat` over literals, not from a clock.
        expect(out.documentCodePoints).toBe(32_520);
        expect(out.answerCodePoints).toBe(1_608);
        // TEN, not "more than one": the CHANGELOG publishes the figure, and a
        // published number a test does not pin is a number that drifts.
        expect(out.candidates).toBe(10);

        // A COLLAPSE CEILING, and a DOMINATED one: with `ASSUMED_PROVIDER_MS`
        // at 450 for two calls the fraction below resolves to under 100 ms, so
        // this cannot go red while that passes. It stays for the MESSAGE —
        // evaluated first, it reports `5000 > 1000`, which a reader diagnoses
        // faster than a fraction. Every figure so far sits under ten; the four
        // probe runs are listed in the comment at the top of this test.
        expect(out.localMedianMs).toBeGreaterThan(0);
        expect(out.localMedianMs).toBeLessThan(1_000);

        // THE GUARD THAT BITES, and the one the design states. Written as a
        // fraction so that changing the assumed latency moves it with the
        // design instead of leaving a stale millisecond behind. This runs in
        // CI on a shared runner, where contention is timed along with the
        // code, so 100 ms is the tolerance the suite actually has.
        expect(out.localFraction).toBeLessThan(0.1);
    });
});
