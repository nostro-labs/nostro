import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The money module underpins every downstream amount; hold it high.
      thresholds: { 'src/money/**': { statements: 90, branches: 85, functions: 90, lines: 90 } },
    },
  },
})
