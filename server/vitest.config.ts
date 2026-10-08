import { defineConfig } from 'vitest/config';

// Full suite: unit tests plus integration tests against a real Postgres.
// TEST_DATABASE_URL points at a throwaway database that globalSetup recreates per run.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
