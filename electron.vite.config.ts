import { resolve } from 'path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          'fleet-cli': 'src/main/fleet-cli.ts',
          // Worker-thread entry for transformers.js embeddings; loaded by
          // embed-service.ts via new Worker(new URL('./embed-worker.mjs', ...)).
          'embed-worker': 'src/main/learnings/embed-worker.ts',
          // Worker-thread entry for reading attached PDFs; loaded by
          // agent/pdf/parse.ts via new Worker(new URL('./pdf-worker.mjs', ...)).
          'pdf-worker': 'src/main/agent/pdf/worker.ts'
        },
        output: { format: 'es' }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts',
          copilot: 'src/preload/copilot.ts',
          annotate: 'src/preload/annotate.ts'
        },
        output: { format: 'cjs' }
      }
    }
  },
  renderer: {
    resolve: {
      // streamdown and @git-diff-view/shiki both depend on shiki ^3, which npm
      // nests beside our own shiki 4 as two more private copies. Rollup then
      // emits all 300-odd language grammars three times over - 25 MB of the
      // renderer's 35 MB of JS was duplicate chunks. Both dependents only call
      // createHighlighter/codeToTokens, which shiki 4 still exports, so one
      // shared copy serves all three.
      dedupe: ['shiki'],
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@copilot': resolve('src/renderer/copilot/src')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: 'src/renderer/index.html',
          copilot: 'src/renderer/copilot/index.html'
        }
      }
    },
    plugins: [react(), tailwindcss()]
  }
});
