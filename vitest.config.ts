import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    // services carry no unit tests yet; the suites land with the features they cover
    passWithNoTests: true,
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
