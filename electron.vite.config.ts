import { resolve } from 'path';
import { cpSync } from 'fs';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';

/** Copy static assets (e.g. prompt templates) into the main-process build output. */
function copyStaticAssets(assets: Array<{ src: string; dest: string }>): Plugin {
  return {
    name: 'copy-static-assets',
    closeBundle() {
      for (const { src, dest } of assets) {
        cpSync(resolve(src), resolve(dest), { recursive: true });
      }
    }
  };
}

export default defineConfig({
  main: {
    plugins: [copyStaticAssets([{ src: 'src/main/starbase/prompts', dest: 'out/main/prompts' }])],
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          'fleet-cli': 'src/main/fleet-cli.ts',
          'starbase-runtime-process': 'src/main/starbase-runtime-process.ts'
        },
        output: { format: 'es' }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        output: { format: 'cjs' }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
});
