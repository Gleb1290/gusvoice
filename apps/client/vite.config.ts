import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Alias the shared workspace package to its TypeScript source so Vite transpiles it
// as part of the app (rather than serving raw .ts from node_modules).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@gusvoice/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    // Never inline fonts as data: URIs — the CSP in nginx.conf is `font-src 'self'`, so an inlined face is
    // blocked (console errors, and the tiny fontsource subsets — Cyrillic-ext: ґ є қ ә ү ₴…, Vietnamese —
    // silently fall back to a system font). Other small assets keep Vite's default 4 KiB rule.
    assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined),
  },
});
