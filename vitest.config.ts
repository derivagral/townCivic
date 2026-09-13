import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: {
      // The suite makes a few hundred requests through `createApp`, and a line
      // each would bury the test output. The tests that care about the log hand
      // `createApp` a sink of their own, which this does not affect.
      TOWNCIVIC_ACCESS_LOG: 'off',
    },
  },
});
