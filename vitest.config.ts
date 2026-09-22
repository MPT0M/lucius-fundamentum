import { defineConfig } from 'vitest/config';

// The suite is hermetic by design: no network, no API key, no environment
// variable. It has to stay green on a fork's pull request, where secrets are
// never available. That is why only `*.test.ts` files under bench/src are
// included: a `run.ts` that will need a key and the network is not a test
// file and never enters the suite — excluded by name, not by list.
//
// The example's tests are `.js`, and they are here for the same reason the
// bench's are: a `.ts` test cannot import a JSDoc-typed `.js` module without
// `allowJs`, and turning that on for the main type-check config pulls in files
// the example has no business touching. So the test sits beside its subject.
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts', 'bench/src/**/*.test.ts', 'examples/**/*.test.js'],
        environment: 'node',
    },
});
