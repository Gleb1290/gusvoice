// Bundle the presence service (+ the private @gusvoice/shared package) into a single
// MINIFIED dist/index.js. npm dependencies stay EXTERNAL (loaded from node_modules at
// runtime, unbundled). Only OUR TypeScript is inlined + minified -- a build artifact of public
// (AGPL-3.0-only) source, not a way to hide it. See packages/backend/build.mjs.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  alias: {
    '@gusvoice/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
  },
  logLevel: 'info',
});
