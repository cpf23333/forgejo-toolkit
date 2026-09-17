const fs = require('fs');
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const config = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  define: {
    // Production builds strip the mock server module (msw + fixtures) via
    // dead-code elimination of the guarded import in extension.ts.
    'process.env.FORGEJO_TOOLKIT_INCLUDE_MOCKS': production ? '"false"' : '"true"',
  },
};

// The MCP server runs as a plain Node child process (spawned by VS Code from
// the McpStdioServerDefinition): there is no vscode module to import, so the
// bundle must never reference one. The guard turns an accidental
// `import 'vscode'` anywhere in the MCP dependency graph into a build error.
const forbidVscodePlugin = {
  name: 'forbid-vscode',
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({
      errors: [{ text: 'The MCP server bundle must not import the vscode module.' }],
    }));
  },
};

const mcpConfig = {
  entryPoints: ['mcp/server.ts'],
  bundle: true,
  outfile: 'out/mcp-server.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  plugins: [forbidVscodePlugin],
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context({
      ...config,
      banner: {
        js: '/* forgejo-toolkit extension watch build */',
      },
    });
    await ctx.watch();
    const mcpCtx = await esbuild.context(mcpConfig);
    await mcpCtx.watch();
    console.log('[extension] watching...');
    console.log('[extension] build complete');
  } else {
    if (production) {
      fs.rmSync('out/extension.js.map', { force: true });
      fs.rmSync('out/mcp-server.js.map', { force: true });
    }
    await esbuild.build(config);
    await esbuild.build(mcpConfig);
    console.log('[extension] build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
