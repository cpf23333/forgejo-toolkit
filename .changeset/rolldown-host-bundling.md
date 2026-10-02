---
'forgejo-toolkit': patch
---

Bundle the extension host and the MCP server with Rolldown instead of esbuild — the same engine Vite 8 already uses for the webview, so the package now has one bundler rather than two. The packaged extension shrinks by about 20% (1,926,650 → 1,541,037 bytes; 431,627 bytes gzipped, 16.9% smaller) because Rolldown tree-shakes `zod` where esbuild kept it whole, and both builds get faster (development 592 → 339 ms, production 450 → 386 ms). The split is unchanged: two thin `.mjs` entries over the shared code graph in `out/chunks/`, with the MCP entry's no-`vscode` guarantee still enforced by a build-time chunk-graph check. No user-facing behaviour changes.
