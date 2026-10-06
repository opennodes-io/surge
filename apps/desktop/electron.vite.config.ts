import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  main: {
    // Only `dependencies` stay external and ship as node_modules: @libsql/client (native binding)
    // and @opennodes/* (Node-only; @opennodes/core reads its schema relative to import.meta.url, so
    // it must not be bundled). Everything else main imports — @surge/core (source-only), openai,
    // the MCP SDK, Gemini — is a devDependency and is bundled here, resolved from the real tree.
    // Shipping those as node_modules went wrong: electron-builder's pnpm collector put top-level
    // versions where nested duplicates belong (see packaging/check-node-modules.cjs).
    plugins: [externalizeDepsPlugin({ exclude: ['@surge/core'] })],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'src/main/main.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          preload: path.resolve(__dirname, 'src/main/preload.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    root: path.resolve(__dirname, 'src/renderer'),
    build: {
      outDir: path.resolve(__dirname, 'dist/renderer'),
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': path.resolve(__dirname, 'src/renderer')
      }
    }
  }
});
