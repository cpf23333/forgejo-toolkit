import { defineConfig, mergeConfig } from 'vitest/config';
// The `.mts` extension is explicit: the webview's Vite config is an ESM file
// (Vite warns when it has to load ESM syntax as CommonJS), and Vite's own
// config-file bundler resolves only the exact specifier, not a `.mts` file
// behind an extensionless `./vite.config`.
import viteConfig from './vite.config.mts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // jsdom stays, and not for lack of trying: `happy-dom` made this suite
      // ~57 % faster (18.4 s vs 43 s wall clock, environment build ~5x cheaper)
      // but was rejected for a security reason. `happy-dom` 20.14.5's
      // `NodeIterator` stops advancing after a node is removed mid-iteration,
      // and DOMPurify walks the tree with `document.createNodeIterator(...)`
      // *while removing* forbidden nodes — so sanitization stopped after the
      // first removal and `<script>`, inline `style` and `onerror` survived in
      // `sanitizeMarkdownHtml` (12 tests failed, and two adjacent ones that
      // assert the same property diverged, which is the "green for the wrong
      // reason" shape). Anything that makes happy-dom's traversal
      // DOMPurify-compatible must be proven with a payload whose first node is
      // allowed and whose dangerous node comes later. Measured 2026-09-28.
      //
      // The pool is deliberately left at the default `forks`. `vmThreads` was
      // ~3x faster (13 s vs 41 s) but every vm pool leaves `process` undefined
      // inside the test context, and vue-router's development build reads
      // `process.env.NODE_ENV` inside a rejection handler — the run then ends
      // with dozens of unhandled "process is not defined" errors and a
      // non-zero exit despite every test passing. Measured 2026-09-28.
      environment: 'jsdom',
      globals: true,
      include: ['src/**/*.test.ts'],
      setupFiles: ['src/__tests__/setup.ts'],
    },
  }),
);
