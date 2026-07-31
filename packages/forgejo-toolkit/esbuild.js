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
    console.log('[extension] watching...');
    console.log('[extension] build complete');
  } else {
    if (production) {
      fs.rmSync('out/extension.js.map', { force: true });
    }
    await esbuild.build(config);
    console.log('[extension] build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
