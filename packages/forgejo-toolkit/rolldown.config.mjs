// Bundles the extension host and the headless MCP server with Rolldown — the
// same engine Vite 8 already uses to build the webview, so the package has one
// bundler instead of two.
//
// One ESM build with two entry points and code splitting: the extension host
// bundle and the headless MCP server share almost their whole dependency
// graph (the MCP tool logic runs in the extension host for the broker), and
// separate CJS bundles carried a full copy each — about 1.35 MB minified.
// Splitting emits that graph once under out/chunks/ and leaves both entries
// as thin wrappers over it. ESM is what enables splitting, and it is safe
// here: VS Code has loaded ESM extensions since 1.100 (our floor is 1.102),
// the MCP child is plain `node out/mcp-server.mjs`, and neither entry uses
// __dirname or require().
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
// Production is a flag of our own, not one Rolldown knows: its CLI rejects any
// argument it does not recognize with "Option production is unrecognized. We
// will ignore this option.", and `--production` is not in its option list. An
// environment variable avoids that warning and stays cross-platform.
const production = process.env.FORGEJO_TOOLKIT_PRODUCTION === '1';

const packageDir = import.meta.dirname;

/** The two entry bundles. The keys are the file names `entryFileNames` uses. */
const ENTRIES = {
  extension: 'src/extension.ts',
  'mcp-server': 'mcp/server.ts',
};

/**
 * The names every non-chunk file under `out/` must have: the two entries, plus
 * their sourcemaps outside production. Everything else has to be a
 * `chunks/*.mjs` (or its `.map`). `out/webview/**` belongs to Vite and is not
 * this build's output.
 *
 * This is a guard, not documentation: see `assertOutputShape` for why the shape
 * is enforced after every build.
 */
const ENTRY_OUTPUTS = new Set(
  Object.keys(ENTRIES).flatMap((key) => (production ? [`${key}.mjs`] : [`${key}.mjs`, `${key}.mjs.map`])),
);
const CHUNK_OUTPUTS = production ? /^chunks\/[^/]+\.mjs$/ : /^chunks\/[^/]+\.mjs(\.map)?$/;

/**
 * Fails the build on the code-splitting runtime hazard.
 *
 * Rolldown emits an internal runtime chunk for the code it needs on both sides
 * of a split. When that chunk matches neither `entryFileNames` nor
 * `chunkFileNames` it is written as `<name>.js` — and this package has no
 * `"type": "module"`, so Node would load such a file as CommonJS while the
 * `.mjs` entries import it as ESM, failing with `SyntaxError: Named export 'x'
 * not found ... is a CommonJS module`.
 *
 * Two things keep that from happening, and this plugin is the second:
 *
 * 1. `entryFileNames` and `chunkFileNames` are deliberately `*.mjs` patterns,
 *    so every chunk the naming rules cover is ESM whatever its content.
 * 2. Every file under the output directory that is not one of the two entries
 *    or a `chunks/*.mjs` (plus its `.map` outside production) fails the build,
 *    so a runtime or helper chunk that escaped the naming patterns becomes a
 *    loud error instead of a `.js` file shipped inside the `.vsix`.
 *
 * Rolldown does not empty the output directory, and `cleanOutput()` only
 * removes the files it knows about, so a file left behind by an older build (or
 * written by hand) is caught here too — it would be packaged otherwise.
 *
 * A future lazy entry does not need this plugin relaxed: `entryFileNames` is a
 * pattern, so adding an input key emits a matching `.mjs` and only the entry
 * check below has to learn the new name.
 */
function assertOutputShape() {
  return {
    name: 'assert-output-shape',
    writeBundle(options, bundle) {
      const dir = options.dir;
      if (!dir) {
        throw new Error('The build has no output.dir to check (assert-output-shape).');
      }
      const emitted = new Set(Object.keys(bundle));
      for (const key of Object.keys(ENTRIES)) {
        if (!emitted.has(`${key}.mjs`)) {
          throw new Error(
            `The build did not emit ${key}.mjs (emitted: ${[...emitted].sort().join(', ') || 'nothing'}).`,
          );
        }
      }
      const visit = (relative) => {
        const absolute = path.join(dir, relative);
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
          const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
          if (entry.isDirectory()) {
            // out/webview is Vite's output; it is not this build's business.
            if (child !== 'webview') {
              visit(child);
            }
            continue;
          }
          if (!ENTRY_OUTPUTS.has(child) && !CHUNK_OUTPUTS.test(child)) {
            throw new Error(
              `Unexpected file in the extension output: ${child}. This build may only emit ` +
                `${Object.keys(ENTRIES)
                  .map((key) => `${key}.mjs`)
                  .join(', ')} and chunks/*.mjs (plus their .map files outside production). A bare ` +
                '.js file here would be loaded as CommonJS — see the comment on assertOutputShape.',
            );
          }
        }
      };
      visit('');
    },
  };
}

/**
 * Fails the build when the MCP server's chunk graph reaches `vscode`.
 *
 * The MCP server runs as a plain Node child process (spawned by VS Code from
 * the McpStdioServerDefinition): there is no vscode module to import, so its
 * chunk graph must never reference one. With a single build the old
 * onResolve guard could not tell the two entries apart, so the check walks the
 * bundle instead: every chunk reachable from the mcp-server entry is visited,
 * and a vscode import anywhere in that subgraph fails the build.
 *
 * External specifiers are **not** in `chunk.moduleIds` in Rolldown — they
 * appear in `chunk.imports`. A port that only looked at `moduleIds` compiled to
 * a check that silently never fires, so both are inspected here.
 */
function assertNoVscodeInMcpEntry() {
  return {
    name: 'assert-no-vscode-in-mcp-entry',
    generateBundle(_options, bundle) {
      const entryFile = Object.keys(bundle).find(
        (file) => bundle[file].type === 'chunk' && bundle[file].isEntry && bundle[file].name === 'mcp-server',
      );
      if (!entryFile) {
        throw new Error('The mcp-server entry chunk was not found in the bundle.');
      }
      const seen = new Set();
      const queue = [entryFile];
      while (queue.length > 0) {
        const file = queue.shift();
        if (file === undefined || seen.has(file)) {
          continue;
        }
        seen.add(file);
        const chunk = bundle[file];
        if (!chunk || chunk.type !== 'chunk') {
          continue;
        }
        for (const specifier of chunk.imports) {
          if (isVscodeSpecifier(specifier)) {
            throw new Error(`The MCP server bundle must not import the vscode module (reachable from ${file}).`);
          }
          queue.push(specifier);
        }
        for (const moduleId of chunk.moduleIds) {
          if (isVscodeSpecifier(moduleId)) {
            throw new Error(`The MCP server bundle must not import the vscode module (reachable from ${file}).`);
          }
        }
      }
    },
  };
}

function isVscodeSpecifier(specifier) {
  return specifier === 'vscode' || specifier.endsWith('/vscode');
}

/**
 * Prints the line `.vscode/tasks.json` waits for: the `dev` preLaunchTask's
 * `endsPattern` is `^\[extension\] build complete$`, so without it the task
 * never reports "background ready". It runs on the first build and on every
 * watch rebuild.
 */
function announceBuildComplete() {
  return {
    name: 'announce-build-complete',
    writeBundle(options) {
      const dir = options.dir;
      const entries = Object.keys(ENTRIES).map((key) => {
        const file = path.join(dir, `${key}.mjs`);
        return `${key}.mjs (${fs.statSync(file).size} B)`;
      });
      console.log(`[extension] build complete: ${entries.join(', ')}`);
    },
  };
}

const config = {
  cwd: packageDir,
  input: ENTRIES,
  // The vscode API only exists inside the extension host; the MCP server child
  // process has no such module, and `assert-no-vscode-in-mcp-entry` fails the
  // build if its graph ever reaches for one.
  external: ['vscode'],
  platform: 'node',
  // esbuild takes `define` at the top level; Rolldown 1.x only reads it under
  // `transform` (Oxc's global-variable replacement) and ignores a top-level one
  // with an "Invalid input options" warning.
  transform: {
    define: {
      // Production builds strip the mock server module (msw + fixtures) via
      // dead-code elimination of the guarded import in extension.ts.
      'process.env.FORGEJO_TOOLKIT_INCLUDE_MOCKS': production ? '"false"' : '"true"',
    },
  },
  plugins: [assertNoVscodeInMcpEntry(), assertOutputShape(), announceBuildComplete()],
  output: {
    dir: 'out',
    format: 'esm',
    // Both patterns end in `.mjs` on purpose: the package has no
    // `"type": "module"`, so a chunk emitted as `.js` would be loaded as
    // CommonJS even though the entries import it as ESM.
    entryFileNames: '[name].mjs',
    chunkFileNames: 'chunks/[name]-[hash].mjs',
    hashCharacters: 'hex',
    sourcemap: !production,
    // Rolldown's default is `'dce-only'`, which drops dead code but skips
    // compression; that produced a build larger than the esbuild one it
    // replaces. Set it explicitly so a future default cannot regress it, and
    // keep the development build unminified.
    minify: production,
    banner: [
      // CJS dependencies (undici, the SDK) keep real require() calls, which an
      // ESM bundle cannot resolve: the bundler rewrites them into a "dynamic
      // require" shim that throws at runtime. Pre-seeding a createRequire-based
      // `require` makes the shim pick it up instead. The banner lands in every
      // chunk, but each chunk is its own module scope, so the declaration is
      // local (and unused copies are harmless).
      watch ? '/* forgejo-toolkit extension watch build */' : undefined,
      "import { createRequire as __forgejoCreateRequire } from 'node:module';",
      'const require = __forgejoCreateRequire(import.meta.url);',
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
  },
};

// Rolldown does not empty the outdir, and the shared chunks are content-hashed:
// every code change mints a new file and the old one would linger (and get
// packaged). Clear the bundled outputs before each build; out/webview is Vite's
// own territory and stays untouched. Whatever the cleanup misses,
// `assert-output-shape` rejects after the build.
fs.rmSync(path.join(packageDir, 'out', 'chunks'), { recursive: true, force: true });
for (const entry of Object.keys(ENTRIES)) {
  for (const suffix of ['.mjs', '.mjs.map', '.js', '.js.map']) {
    fs.rmSync(path.join(packageDir, 'out', `${entry}${suffix}`), { force: true });
  }
}

console.log('[extension] watching...');
console.log('[extension] start build');

export default config;
