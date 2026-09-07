import { defineConfig } from 'vitest/config';

// The suite is hermetic by design: no network, no API key, no environment
// variable. It has to stay green on a fork's pull request, where secrets are
// never available.
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
    },
});
