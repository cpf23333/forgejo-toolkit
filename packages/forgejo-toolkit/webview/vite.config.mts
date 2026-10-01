import { defineConfig, type Plugin } from 'vite';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import vue from '@vitejs/plugin-vue';

// vscode-elements' <vscode-icon> pulls the codicon stylesheet into its shadow
// DOM by reading the href of a <link id="vscode-codicon-stylesheet"> in the
// page (see content.ts). Ship that stylesheet with the webview bundle so the
// packaged extension does not need node_modules at runtime.
function copyCodicons(outDir: string) {
  const require = createRequire(import.meta.url);
  const dist = path.dirname(require.resolve('@vscode/codicons/dist/codicon.css'));
  for (const file of ['codicon.css', 'codicon.ttf']) {
    fs.copyFileSync(path.join(dist, file), path.join(outDir, file));
  }
}

/**
 * One HTML document per webview surface, each with its own entry module.
 *
 * The host picks the document in `src/webview/content.ts` (`panelMode` →
 * `onboarding.html` / `pullReviewComment.html`, otherwise `index.html`). Before
 * this split every surface loaded `index.html` and `main.ts`, which is how
 * opening a panel ended up downloading and parsing the whole dashboard shell.
 */
const SURFACES = [
  { kind: 'dashboard', html: 'index.html', entry: 'src/main.ts', root: 'App.vue' },
  {
    kind: 'panel',
    html: 'onboarding.html',
    entry: 'src/entries/onboarding.ts',
    root: 'OnboardingPanel.vue',
  },
  {
    kind: 'panel',
    html: 'pullReviewComment.html',
    entry: 'src/entries/pullReviewComment.ts',
    root: 'PullReviewCommentPanel.vue',
  },
  {
    kind: 'panel',
    html: 'aiPreReview.html',
    entry: 'src/entries/aiPreReview.ts',
    root: 'AiPreReviewPanel.vue',
  },
] as const;

/** The standalone panels' root components, each its own surface. */
const PANEL_ROOTS = ['OnboardingPanel.vue', 'PullReviewCommentPanel.vue', 'AiPreReviewPanel.vue'] as const;

/** The `@vscode-elements/elements` component directory a module id/specifier names. */
const ELEMENT_MODULE = /@vscode-elements\/elements\/dist\/(vscode-[a-z0-9-]+)\//;

/** Module specifiers a source references, static (`from`, bare) or dynamic. */
function specifiersOf(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    found.add(match[1]);
  }
  for (const match of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    found.add(match[1]);
  }
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.add(match[1]);
  }
  return [...found];
}

/** Element modules an entry declares, read from its own source (its import list). */
function declaredElementModules(entry: string): Set<string> {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, entry), 'utf8');
  const elements = new Set<string>();
  for (const specifier of specifiersOf(source)) {
    const element = ELEMENT_MODULE.exec(specifier);
    if (element) {
      elements.add(element[1]);
    }
  }
  return elements;
}

/**
 * The declared elements plus the element modules they import themselves.
 *
 * `vscode-context-menu` registers its own `vscode-context-menu-item` and
 * `vscode-tree` pulls in `vscode-scrollable`, so a surface's bundle legitimately
 * carries element modules its entry never names. Walking the package's own
 * imports is what keeps the assertion below about the surface's own choices
 * rather than about the component library's internals.
 */
function elementModuleClosure(declared: Set<string>): Set<string> {
  const require = createRequire(import.meta.url);
  const allowed = new Set(declared);
  const visited = new Set<string>();
  const queue = [...declared].map((element) => require.resolve(`@vscode-elements/elements/dist/${element}/index.js`));
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    for (const specifier of specifiersOf(fs.readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) {
        continue;
      }
      const resolved = path.resolve(path.dirname(file), specifier);
      if (visited.has(resolved)) {
        continue;
      }
      queue.push(resolved);
      const element = ELEMENT_MODULE.exec(resolved.replace(/\\/g, '/'));
      if (element) {
        allowed.add(element[1]);
      }
    }
  }
  return allowed;
}

/**
 * The dashboard shell a standalone panel must not reach. `App.vue` and the
 * router are the sidebar's shell; a panel that pulls either of them is loading
 * the whole dashboard again, which is what the per-surface entries exist to stop.
 */
const DASHBOARD_SHELL = [
  { label: 'App.vue (the dashboard shell)', pattern: /[/\\]App\.vue$/ },
  { label: 'the dashboard router', pattern: /[/\\]router[/\\]index\.ts$/ },
  { label: 'the dashboard entry', pattern: /[/\\]src[/\\]main\.ts$/ },
  { label: 'a dashboard view', pattern: /[/\\]views[/\\]Dashboard\.vue$/ },
  { label: 'the vue-router implementation', pattern: /[/\\]node_modules[/\\]vue-router[/\\]/ },
];

/**
 * The message catalogs, by locale.
 *
 * `en.json` is the base catalog: the i18n module imports it statically and uses
 * it as `fallbackLocale`, so it belongs in every surface's bundle. Every other
 * catalog is reached through the dynamic `import()`s in `src/i18n/locales.ts`
 * and becomes a chunk fetched when that language is selected — the whole point
 * of the split, since the two catalogs are the largest item in the chunk every
 * surface used to download. `LOCALE_MODULE` recognises the *built* module id
 * (an absolute path to the JSON file).
 */
const LOCALES = ['en', 'zh'] as const;
const BASE_LOCALE = 'en';
const LOCALE_MODULE = /[/\\]i18n[/\\]([a-z]{2})\.json$/;

/** The locale a built module id is a catalog for. */
function localeOf(moduleId: string): string | undefined {
  const locale = LOCALE_MODULE.exec(moduleId)?.[1];
  return locale && (LOCALES as readonly string[]).includes(locale) ? locale : undefined;
}

/**
 * Fails the build when a surface's bundle graph reaches something it must not:
 * a standalone panel must not include the dashboard shell (or the other panel)
 * and may only register the `@vscode-elements/elements` modules its own entry
 * declares; the dashboard must still be the surface that carries `App.vue` and
 * the router. This is the webview counterpart of the metafile assertion esbuild
 * runs over the host bundle (see `esbuild.js`).
 *
 * It also holds the locale split: a chunk that every surface preloads must not
 * carry a non-base catalog, which is what would happen again the moment one of
 * them imported a catalog statically.
 */
function assertSurfaceGraph(): Plugin {
  return {
    name: 'assert-webview-surface-graph',
    enforce: 'post',
    writeBundle(_options, bundle) {
      const chunkOf = (file: string) => {
        const chunk = bundle[file];
        return chunk && chunk.type === 'chunk' ? chunk : undefined;
      };
      const chunkModules = (file: string): string[] => {
        const chunk = chunkOf(file);
        if (!chunk) {
          return [];
        }
        const modules = chunk.moduleIds ?? Object.keys(chunk.modules ?? {});
        if (modules.length === 0) {
          throw new Error(`Cannot assert the bundle graph: ${file} reports no module ids.`);
        }
        return modules;
      };
      const normalize = (file: string) => file.replace(/^\.\//, '');
      /**
       * Every module reachable from `entry` over `edges`, or over static
       * imports plus dynamic ones when `edges` is omitted.
       *
       * The distinction is what the locale assertion needs: a module only a
       * dynamic `import()` reaches is a chunk fetched later, not something the
       * surface already downloaded.
       */
      const reachableVia = (
        entry: string,
        edges?: (chunk: { imports: string[]; dynamicImports: string[] }) => string[],
      ): Set<string> => {
        const seenFiles = new Set<string>();
        const modules = new Set<string>();
        const queue = [normalize(entry)];
        while (queue.length > 0) {
          const file = queue.shift()!;
          if (seenFiles.has(file)) {
            continue;
          }
          seenFiles.add(file);
          for (const id of chunkModules(file)) {
            modules.add(id);
          }
          const chunk = chunkOf(file);
          if (!chunk) {
            continue;
          }
          const next = edges ? edges(chunk) : [...chunk.imports, ...chunk.dynamicImports];
          for (const imported of next) {
            queue.push(normalize(imported));
          }
        }
        return new Set([...modules].map((id) => id.replace(/\\/g, '/')));
      };
      const reachable = (entry: string) => reachableVia(entry);
      /** The modules a surface has by the time its entry module has run. */
      const reachableStatic = (entry: string) => reachableVia(entry, (chunk) => chunk.imports);

      for (const surface of SURFACES) {
        const html = bundle[surface.html];
        if (!html || html.type !== 'asset') {
          throw new Error(`The ${surface.kind} HTML document ${surface.html} was not emitted.`);
        }
        const markup = typeof html.source === 'string' ? html.source : new TextDecoder().decode(html.source);
        const script = /<script[^>]*src="\.\/([^"]+)"/.exec(markup);
        if (!script) {
          throw new Error(`${surface.html} carries no entry script; cannot assert its bundle graph.`);
        }
        const modules = reachable(script[1]);
        const declared = declaredElementModules(surface.entry);
        const allowed = elementModuleClosure(declared);

        // Every surface carries its own root component, and a standalone panel
        // reaches no other panel's root either.
        if (![...modules].some((id) => id.endsWith(surface.root))) {
          throw new Error(`${surface.html} does not reach its root component ${surface.root}.`);
        }
        if (surface.kind === 'panel') {
          for (const id of modules) {
            const leaked = DASHBOARD_SHELL.find((shell) => shell.pattern.test(id));
            if (leaked) {
              throw new Error(`${surface.html} reaches ${leaked.label} through ${id}.`);
            }
            for (const other of PANEL_ROOTS) {
              if (other !== surface.root && id.replace(/\\/g, '/').endsWith(`/${other}`)) {
                throw new Error(`${surface.html} reaches the other panel's root through ${id}.`);
              }
            }
          }
        } else {
          for (const required of ['App.vue', 'router/index.ts']) {
            if (![...modules].some((id) => id.endsWith(required))) {
              throw new Error(`${surface.html} does not reach ${required}; its entry is not the dashboard.`);
            }
          }
          for (const panel of PANEL_ROOTS) {
            const reached = [...modules].find((id) => id.replace(/\\/g, '/').endsWith(`/${panel}`));
            if (reached) {
              throw new Error(`${surface.html} reaches the standalone panel ${reached}.`);
            }
          }
        }

        // The locale split. `modules` spans the surface's whole graph, dynamic
        // chunks included, so the catalogs found here are the ones it can load
        // — the base catalog has to be there (it is the fallback) and every
        // other catalog has to be *only* a dynamic import, because a static one
        // would put it back in the chunk preloaded by all three surfaces.
        const staticModules = reachableStatic(script[1]);
        const baseCatalog = [...staticModules].find((id) => localeOf(id) === BASE_LOCALE);
        if (!baseCatalog) {
          throw new Error(
            `${surface.html} does not bundle the base message catalog (${BASE_LOCALE}.json); its fallbackLocale has nothing to fall back to.`,
          );
        }
        const staticallyBundled = [...staticModules]
          .map(localeOf)
          .filter((locale): locale is string => locale !== undefined && locale !== BASE_LOCALE);
        if (staticallyBundled.length > 0) {
          throw new Error(
            `${surface.html} bundles message catalogs statically that must stay lazy: ${staticallyBundled.join(', ')}. ` +
              'Only the base catalog may be imported statically (see src/i18n/locales.ts).',
          );
        }

        const registered = new Set<string>();
        for (const id of modules) {
          const element = ELEMENT_MODULE.exec(id);
          if (element) {
            registered.add(element[1]);
          }
        }
        const unexpected = [...registered].filter((element) => !allowed.has(element));
        if (unexpected.length > 0) {
          throw new Error(
            `${surface.html} bundles @vscode-elements/elements modules its entry does not use: ${unexpected.join(', ')}.`,
          );
        }
        const missing = [...declared].filter((element) => !registered.has(element));
        if (missing.length > 0) {
          throw new Error(`${surface.html} does not bundle the declared element modules: ${missing.join(', ')}.`);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag: string) => tag.startsWith('vscode-'),
        },
      },
    }),
    {
      name: 'copy-codicons',
      closeBundle() {
        copyCodicons(path.resolve(import.meta.dirname, '..', 'out', 'webview'));
      },
    },
    assertSurfaceGraph(),
  ],
  root: path.resolve(import.meta.dirname),
  base: './',
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue'],
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  css: {
    transformer: 'lightningcss',
  },
  build: {
    outDir: path.resolve(import.meta.dirname, '..', 'out', 'webview'),
    emptyOutDir: true,
    assetsInlineLimit: 1024 * 1024,
    rollupOptions: {
      input: Object.fromEntries(
        SURFACES.map((surface) => [
          surface.html.replace(/\.html$/, ''),
          path.resolve(import.meta.dirname, surface.html),
        ]),
      ),
    },
  },
});
