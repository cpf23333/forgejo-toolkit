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
      // jsdom is still the environment, but not for the reason this comment
      // used to give. `happy-dom` is ~2x faster for this suite (26.4 s vs 57.0 s
      // wall clock, medians of 3 interleaved runs each; its environment build is
      // ~5x cheaper), but it needs two semantic repairs before DOMPurify behaves
      // on it, and only the first one is in the tree:
      //
      // 1. DONE — happy-dom 20.14.5's `NodeIterator` implements neither the DOM
      //    Standard's pre-remove steps nor the node pointer's `candidate
      //    reference`. DOMPurify walks the tree with
      //    `document.createNodeIterator(...)` *while removing* forbidden nodes,
      //    so sanitization stopped after the first removal and `<script>`, inline
      //    `style` and `onerror` survived. The first-party (MIT) transcription of
      //    the standard's traversal lives in
      //    `src/__tests__/helpers/happyDomNodeIterator.ts`; `src/__tests__/setup.ts`
      //    installs it before any test module can import DOMPurify (which
      //    captures `document.createNodeIterator` at module-init time), only when
      //    the environment is happy-dom — set
      //    `FORGEJO_TOOLKIT_FORCE_NODE_ITERATOR_SHIM=1` to force it over jsdom,
      //    which is how the differential check runs it.
      //    Evidence: the load-bearing payload in `markdown.test.ts` passes; the
      //    corpus of 48 sanitize payloads produces byte-identical output under
      //    jsdom+shim and under jsdom alone; and WPT's
      //    `dom/traversal/NodeIterator-removal.html` expectations all hold under
      //    the shim, where jsdom 30.0.1's own iterator mismatches 38 iterator
      //    states (it has not caught up with the standard's "the removed node is
      //    an inclusive ancestor of the root" clause, nor with the candidate
      //    pointer that keeps a removal made inside a filter callback from
      //    stranding the walk). Measured 2026-10-03.
      //
      // 2. OPEN — happy-dom's `Node.prototype.nodeName` is a stub that returns ''
      //    (every subclass overrides it, so ordinary property access is correct),
      //    but DOMPurify 3.4.16 caches that base getter at module-init time as an
      //    anti-clobbering measure and calls it directly: every element's tag name
      //    reads as '', every element is therefore "not allowed" and removed, and
      //    sanitization returns nothing. With the shim in place the corpus still
      //    diverges from jsdom on 46 of its 48 payloads and 34 tests fail. A
      //    second repair that dispatches the base getter to the subclass override
      //    makes the whole suite pass on happy-dom (157 files / 979 tests) in the
      //    26.4 s above, but it is a second happy-dom semantic repair rather than
      //    part of this traversal, so it is not in the tree; the choice is
      //    recorded in the TODO entry. Measured 2026-10-03.
      //
      //    Upstream leads for this second defect, all seen 2026-10-03:
      //    `capricorn86/happy-dom#2182`
      //    (https://github.com/capricorn86/happy-dom/issues/2182) carries the
      //    same diagnosis; `#2183`
      //    (https://github.com/capricorn86/happy-dom/pull/2183) is a fix PR in
      //    that direction, still open after about a month, and it is not the
      //    withdrawn `#2429`, which was about `NodeIterator`; and `#1629`
      //    (https://github.com/capricorn86/happy-dom/issues/1629) is happy-dom's
      //    own tracking issue for DOMPurify compatibility, on its Security
      //    milestone.
      //
      //    Independent, third-party corroboration is a 2026-07-14 post, "I
      //    upgraded DOMPurify, so why did I end up fixing happy-dom?"
      //    (https://www.joseph0926.com/en/post/2026-07-14-upgraded-dompurify-why-fix-happy-dom):
      //    it hits the same mechanism on DOMPurify 3.3.1 -> 3.4.11 with
      //    happy-dom 20.10.6. Its author pinned DOMPurify back to 3.3.1 and left
      //    the happy-dom repair upstream, writing no repair code, and its central
      //    warning is that a happy-dom-based sanitize path can under-sanitize
      //    *silently* — nodes pass through unvisited and a green test suite does
      //    not catch it — which is why DOMPurify's own documentation recommends
      //    jsdom server-side rather than happy-dom.
      //
      // What follows for the decision: jsdom stays the trusted oracle for the
      // sanitizing tests; this shim is in the tree so the differential can be
      // reproduced and so a future switch stays one environment variable away;
      // and the second defect remains open. Two things would reopen the
      // decision — (a) happy-dom shipping a fix for the `nodeName` stub (`#2183`
      // landing would be one) and (b) the differential then still showing the
      // payload corpus byte-identical to jsdom.
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
