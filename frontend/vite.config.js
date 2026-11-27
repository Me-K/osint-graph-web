import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'application-license',
      apply: 'build',
      // Include the application license and dependency notice with every frontend build.
      generateBundle() {
        for (const fileName of ['LICENSE', 'THIRD_PARTY.md']) {
          this.emitFile({
            type: 'asset',
            fileName,
            source: readFileSync(new URL(`../${fileName}`, import.meta.url), 'utf8'),
          })
        }
      },
    },
  ],
})
