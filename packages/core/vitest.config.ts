import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
        // Every downstream amount and record passes through these; hold them high.
        'src/money/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/model/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/store/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
})
