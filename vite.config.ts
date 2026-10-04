import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

export default defineConfig({
  // Relative base: the same build works at / and under a sub-path such as /mishrin-console/ (Gyanagi).
  // Override with MISHRIN_BASE=/mishrin-console/ for an absolute base.
  base: process.env.MISHRIN_BASE || './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    cssCodeSplit: true,
    reportCompressedSize: false,
    assetsInlineLimit: 0,
    rollupOptions: { output: { entryFileNames: 'assets/[name]-[hash].js', chunkFileNames: 'assets/[name]-[hash].js' } },
  },
  worker: { format: 'es' },
  // Cross-origin isolation (COOP/COEP) unlocks SharedArrayBuffer + WASM threads but breaks
  // third-party game URLs in iframes. MPC detects it at runtime; see README to enable it.
});
