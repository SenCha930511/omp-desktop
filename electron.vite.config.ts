import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Chromium loads the WOFF2 source first. Dropping the WOFF and TTF fallbacks
// removes about 1.1 MiB of duplicate font payload from the packaged app.
const katexWoff2Only = {
  name: 'katex-woff2-only',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.includes('/katex/dist/katex.min.css')) return
    return code.replace(/,url\([^)]*\.woff\) format\("woff"\)/g, '').replace(/,url\([^)]*\.ttf\) format\("truetype"\)/g, '')
  },
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Fully minify production code: Electron never consumes readable output,
    // and less source is faster for V8 to read, parse, and compile at startup.
    build: {
      lib: { entry: 'electron/main/index.ts' },
      minify: 'esbuild',
      rollupOptions: {
        output: {
          manualChunks(id) {
            // Keep these cohesive runtime modules separate while preserving
            // synchronous initialization and every existing startup lifecycle.
            if (id.endsWith('/electron/main/agent-rpc/word-prediction.ts') || id.endsWith('/src/lib/word-prediction.ts')) return 'word-prediction'
            if (id.endsWith('/electron/main/sessions/transcript.ts')) return 'session-transcript'
            if (id.endsWith('/electron/main/projects.ts')) return 'projects-service'
            return undefined
          },
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: 'electron/preload/index.ts', formats: ['cjs'] },
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } },
    },
  },
  renderer: {
    root: '.',
    plugins: [react(), katexWoff2Only],
    resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
    // Full minification, but function names survive so the React component
    // stacks ErrorBoundary logs stay readable; no sourcemap can restore those,
    // since React reads them from the function names at runtime. Costs ~4% of
    // renderer bytes, far less than keeping every identifier (~40%).
    esbuild: { keepNames: true },
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: resolve('index.html'),
        output: {
          manualChunks(id) {
            // Keep the large, synchronous locale dictionaries together without
            // turning translation into an asynchronous loading boundary.
            if (id.includes('/src/i18n/keys/')) return 'i18n-catalogs'
            if (!id.includes('node_modules')) return undefined
            // Keep the lazy math chunk ahead of the broad Markdown vendor rule.
            if (id.includes('/remark-math/') || id.includes('/katex/') || id.includes('/rehype-katex/')) return 'katex-vendor'
            if (id.includes('/react-markdown/') || id.includes('/remark-') || id.includes('/unified/')) return 'markdown-vendor'
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react-vendor'
            if (id.includes('/lucide-react/')) return 'icons-vendor'
            return undefined
          },
        },
      },
    },
  },
})
