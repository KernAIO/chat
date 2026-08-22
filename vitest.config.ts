import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Each suite migrates its own scratch database before the first test runs.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Suites run in parallel but each one holds a Postgres pool, so keep the fan-out modest.
    maxWorkers: 3,
    minWorkers: 1,
    env: { NODE_ENV: 'test', LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent' },
  },
})
