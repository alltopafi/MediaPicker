import { defineConfig } from 'vitest/config';

// Pure unit tests only; no database needed.
export default defineConfig({
  test: {
    include: ['test/weighting.test.ts'],
  },
});
