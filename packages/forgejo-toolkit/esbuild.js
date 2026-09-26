const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// One ESM build with two entry points and code splitting: the extension host
// bundle and the headless MCP server share almost their whole dependency
// graph (the MCP tool logic runs in the extension host for the broker), and
// separate CJS bundles carried a full copy each — about 1.35 MB minified.
// Splitting emits that graph once under out/chunks/ and leaves both entries
// as thin wrappers over it. ESM is what enables splitting, and it is safe
// here: VS Code has loaded ESM extensions since 1.100 (our floor is 1.102),
// the MCP child is plain `node out/mcp-server.mjs`, and neither entry uses
// __dirname or require().
const config = {
  entryPoints: [
    { in: 'src/extension.ts', out: 'extension' },
    { in: 'mcp/server.ts', out: 'mcp-server' },
  ],
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outdir: 'out',
  outExtension: { '.js': '.mjs' },
  chunkNames: 'chunks/[name]-[hash]',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  metafile: true,
  banner: {
    // CJS dependencies (undici, the SDK) keep real require() calls, which an
    // ESM bundle cannot resolve: esbuild rewrites them into a "dynamic
    // require" shim that throws at runtime. Pre-seeding a createRequire-based
    // `require` makes the shim pick it up instead. The banner lands in every
    // chunk, but each chunk is its own module scope, so the declaration is
    // local (and unused copies are harmless).
    js: "import { createRequire as __forgejoCreateRequire } from 'node:module';\nconst require = __forgejoCreateRequire(import.meta.url);",
  },
  define: {
    // Production builds strip the mock server module (msw + fixtures) via
    // dead-code elimination of the guarded import in extension.ts.
    'process.env.FORGEJO_TOOLKIT_INCLUDE_MOCKS': production ? '"false"' : '"true"',
  },
  plugins: [
    // The MCP server runs as a plain Node child process (spawned by VS Code
    // from the McpStdioServerDefinition): there is no vscode module to import,
    // so its chunk graph must never reference one. With a single build the old
    // onResolve guard cannot tell the two entries apart, so the check walks
    // the metafile instead: every chunk reachable from the mcp-server entry is
    // visited, and a vscode import anywhere in that subgraph fails the build.
    {
      name: 'assert-no-vscode-in-mcp-entry',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0 || !result.metafile) {
            return;
          }
          const outputs = result.metafile.outputs;
          const entry = Object.keys(outputs).find((file) => outputs[file].entryPoint === 'mcp/server.ts');
          const seen = new Set();
          const queue = [entry];
          while (queue.length > 0) {
            const file = queue.shift();
            if (!file || seen.has(file)) {
              continue;
            }
            seen.add(file);
            for (const imported of outputs[file].imports) {
              if (imported.external && imported.path === 'vscode') {
                throw new Error(`The MCP server bundle must not import the vscode module (reachable from ${file}).`);
              }
              if (!imported.external) {
                queue.push(imported.path);
              }
            }
          }
        });
      },
    },
  ],
};

async function main() {
  // esbuild does not empty the outdir: shared chunks are content-hashed, so
  // every code change mints a new file and the old one would linger (and get
  // packaged). Clear the bundled outputs before each build; out/webview is
  // Vite's own territory and stays untouched.
  fs.rmSync(path.join('out', 'chunks'), { recursive: true, force: true });
  for (const entry of ['extension', 'mcp-server']) {
    for (const ext of ['.js', '.mjs', '.js.map', '.mjs.map']) {
      fs.rmSync(path.join('out', `${entry}${ext}`), { force: true });
    }
  }
  if (watch) {
    const ctx = await esbuild.context({
      ...config,
      banner: {
        js: `/* forgejo-toolkit extension watch build */\n${config.banner.js}`,
      },
    });
    await ctx.watch();
    console.log('[extension] watching...');
    console.log('[extension] build complete');
  } else {
    await esbuild.build(config);
    console.log('[extension] build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
