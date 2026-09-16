// Bundle the backend (+ the private @gusvoice/shared package) into a single MINIFIED
// dist/index.js. npm dependencies stay EXTERNAL — they are loaded from node_modules at
// runtime, unbundled, exactly as they run under tsx today (zero risk of a bundler
// mangling Fastify/pg). Only OUR TypeScript (backend src + shared src) is inlined and
// minified, so the image stays small and starts without a TypeScript loader. The source itself is
// public (AGPL-3.0-only) now: the bundle is a build artifact, not a way to hide it -- LICENSING.md says
// what an operator who redistributes a modified build owes their users.
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
  // Keep every npm package external (resolved from node_modules at runtime)…
  packages: 'external',
  // …but INLINE the workspace shared package (its src is private) by aliasing the bare
  // specifier to its entry file, so esbuild treats it as a local module and bundles it.
  alias: {
    '@gusvoice/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
  },
  logLevel: 'info',
});
