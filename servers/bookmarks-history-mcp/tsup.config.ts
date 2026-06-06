import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { stdio: 'src/stdio.ts', http: 'src/http.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  // @surge/core is bundled from source; native / SDK deps stay external.
  external: ['@libsql/client', '@modelcontextprotocol/sdk'],
  banner: { js: '#!/usr/bin/env node' },
});
