import { defineConfig } from 'vitest/config'

/**
 * `passWithNoTests` so a copy of this package that has not written its first test yet still reports
 * a green `pnpm test` instead of failing on "no test files found".
 *
 * The timeouts and `fileParallelism: false` are for the integration suite: it creates a scratch
 * database per file, applies every migration and drops it again. Two files doing that at once
 * against one server is slower than doing it in turn, and the default 5s timeout expires during the
 * migration rather than during anything being tested.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
