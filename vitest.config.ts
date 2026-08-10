import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// Run tests from repo root, not the webapp subdir that the vite build
// uses as its root.
export default defineConfig({
  root: here,
  test: {
    include: [
      'test/**/*.test.ts',
      'webapp/src/**/*.test.ts',
      'src/**/*.test.ts'
    ],
    environment: 'node'
  },
  resolve: {
    alias: {
      '@webapp': resolve(here, 'webapp/src')
    }
  }
})
