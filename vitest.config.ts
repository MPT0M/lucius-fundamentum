import { defineConfig } from 'vitest/config';

// The suite is hermetic by design: no network, no API key, no environment
// variable. It has to stay green on a fork's pull request, where secrets are
// never available. That is why only `*.test.ts` files under bench/src are
// included: a `run.ts` that will need a key and the network is not a test
// file and never enters the suite — excluded by name, not by list.
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts', 'bench/src/**/*.test.ts'],
        environment: 'node',
    },
});
