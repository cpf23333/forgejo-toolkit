---
'forgejo-toolkit': patch
---

Shrink the package by ~47% (about 1.4 MB uncompressed): the extension host and the MCP server are now emitted by a single esbuild ESM build with code splitting, so their shared dependency graph (98.9% of the MCP server's modules) ships once under `out/chunks/` instead of being bundled into both `out/extension.js` and `out/mcp-server.js`. The entry points are now `out/extension.mjs` / `out/mcp-server.mjs` (VS Code ≥ 1.102 loads ESM extensions natively); the stable-path shim in globalStorage keeps its `mcp-server.js` name and now `import()`s the ESM bundle, so existing static `mcp.json` configurations keep working, and the MCP entry's no-`vscode` guarantee is enforced by a metafile graph check on every build.
