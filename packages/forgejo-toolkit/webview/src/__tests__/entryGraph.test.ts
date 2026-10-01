import { describe, expect, it } from 'vitest';
import { VSCODE_ELEMENT_TAGS } from './helpers/vscodeElements';

/**
 * Pins the per-surface webview entries.
 *
 * Each surface — the sidebar dashboard and the two standalone panels — is its
 * own Vite entry with its own HTML document (see `webview/vite.config.mts`), so
 * opening the setup wizard or the review comment editor no longer downloads and
 * parses the dashboard shell. `webview/vite.config.mts` asserts the same
 * properties over the built bundle graph; this test is the half that runs
 * without a build, and it is what fails first when an entry grows a dependency
 * it must not have.
 *
 * The sources are read through Vite's glob (the webview tests run without Node
 * types, so `node:fs` is not available here).
 */

const htmlDocuments = import.meta.glob('../../*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Every webview module, plus the JSON message catalogs.
 *
 * The catalogs are part of the graph a surface's bundle is built from, which is
 * what the locale assertions at the bottom of this file are about, so this glob
 * has to see them and not only the `.vue`/`.ts` modules.
 */
const moduleSources = import.meta.glob(['../../src/**/*.{vue,ts,json}', '!../../src/**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** This test file's own directory, for resolving glob keys to webview paths. */
const TEST_DIRECTORY = 'src/__tests__';

/** Module path relative to the webview root (`src/App.vue`) → its source. */
const sources = new Map<string, string>();
for (const [key, source] of Object.entries(moduleSources)) {
  sources.set(normalize(`${TEST_DIRECTORY}/${key}`), source);
}

const html = new Map<string, string>();
for (const [key, source] of Object.entries(htmlDocuments)) {
  html.set(normalize(`${TEST_DIRECTORY}/${key}`), source);
}

interface Surface {
  /** Human name, for failure messages. */
  name: string;
  /** The document the host loads for this surface (`src/webview/content.ts`). */
  html: string;
  /** The module that document boots. */
  entry: string;
  /** The component that entry mounts. */
  root: string;
  /** The `@vscode-elements/elements` components the surface renders. */
  elements: string[];
}

const SURFACES: Surface[] = [
  {
    name: 'dashboard',
    html: 'index.html',
    entry: 'src/main.ts',
    root: 'src/App.vue',
    elements: [
      'vscode-button',
      'vscode-checkbox',
      'vscode-context-menu',
      'vscode-icon',
      'vscode-option',
      'vscode-progress-ring',
      'vscode-single-select',
      'vscode-textfield',
      'vscode-tree',
      'vscode-tree-item',
    ],
  },
  {
    name: 'onboarding panel',
    html: 'onboarding.html',
    entry: 'src/entries/onboarding.ts',
    root: 'src/OnboardingPanel.vue',
    elements: [
      'vscode-button',
      'vscode-checkbox',
      'vscode-icon',
      'vscode-option',
      'vscode-single-select',
      'vscode-textfield',
    ],
  },
  {
    name: 'pull review comment panel',
    html: 'pullReviewComment.html',
    entry: 'src/entries/pullReviewComment.ts',
    root: 'src/PullReviewCommentPanel.vue',
    elements: ['vscode-button', 'vscode-icon', 'vscode-radio', 'vscode-radio-group'],
  },
  {
    name: 'ai pre-review panel',
    html: 'aiPreReview.html',
    entry: 'src/entries/aiPreReview.ts',
    root: 'src/AiPreReviewPanel.vue',
    elements: ['vscode-button', 'vscode-checkbox'],
  },
];

/** The standalone panels' root components, each its own surface. */
const PANEL_ROOTS = ['src/OnboardingPanel.vue', 'src/PullReviewCommentPanel.vue', 'src/AiPreReviewPanel.vue'];

/** The dashboard shell a standalone panel must not reach. */
const DASHBOARD_SHELL: { label: string; pattern: RegExp }[] = [
  { label: 'App.vue (the dashboard shell)', pattern: /^src\/App\.vue$/ },
  { label: 'the dashboard router', pattern: /^src\/router\// },
  { label: 'the dashboard entry', pattern: /^src\/main\.ts$/ },
  { label: 'a dashboard view', pattern: /^src\/views\/Dashboard\.vue$/ },
];

/**
 * The npm packages a standalone panel must not load.
 *
 * `vue-router` is the one that matters: `useAppState` and the two panel views
 * reach the router through `useAppRouter()`, whose only vue-router import is
 * `import type`, and the point of that indirection is that a panel installs no
 * router and must not ship one.
 */
const FORBIDDEN_PACKAGES = ['vue-router'];

const ELEMENT_MODULE = /@vscode-elements\/elements\/dist\/(vscode-[a-z0-9-]+)\//;

/**
 * The message catalogs, by locale.
 *
 * Only the base catalog (`en.json`) may be in a surface's *static* import
 * graph. The other one is reached through a dynamic `import()` in
 * `src/i18n/locales.ts` and becomes a chunk the surface fetches when that
 * language is selected (see the locale assertions at the bottom of this file
 * and `webview/vite.config.mts`, which fails the build if a surface ships both).
 */
const CATALOG_LOCALES = ['en', 'zh'] as const;
const BASE_LOCALE = 'en';

/** The locale a webview-relative module path is a catalog for. */
function catalogLocale(file: string): (typeof CATALOG_LOCALES)[number] | undefined {
  const match = /(?:^|\/)i18n\/([a-z]{2})\.json$/.exec(file);
  return CATALOG_LOCALES.find((locale) => locale === match?.[1]);
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

function directoryOf(file: string): string {
  return file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
}

/**
 * Drops type-only imports, which are erased at build time and therefore cannot
 * put a module in a surface's bundle (`useAppRouter` imports the `Router` type
 * from vue-router this way).
 */
function withoutTypeOnlyImports(source: string): string {
  return source
    .replace(/\b(?:import|export)\s+type\b[\s\S]*?from\s*['"][^'"]+['"]\s*;?/g, '')
    .replace(/\bimport\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g, (statement, body: string) =>
      body
        .split(',')
        .filter((specifier) => specifier.trim() !== '')
        .every((specifier) => /^\s*type\s/.test(specifier))
        ? ''
        : statement,
    );
}

/**
 * Every module specifier a source loads at runtime, split by how it loads it.
 *
 * The split is the point of the locale assertions: a catalog a module imports
 * statically is in the bundle a surface downloads, one it imports dynamically is
 * a chunk fetched on demand.
 */
function specifiersByKind(source: string): { static: string[]; dynamic: string[] } {
  const runtime = withoutTypeOnlyImports(source);
  const dynamic = new Set<string>();
  // Recorded first and removed below, so a `from 'x'` inside an `import('x')`
  // cannot count as static.
  for (const match of runtime.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    dynamic.add(match[1]);
  }
  const staticSpecifiers = new Set<string>();
  for (const match of runtime.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    staticSpecifiers.add(match[1]);
  }
  for (const match of runtime.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    staticSpecifiers.add(match[1]);
  }
  for (const specifier of dynamic) {
    staticSpecifiers.delete(specifier);
  }
  return { static: [...staticSpecifiers], dynamic: [...dynamic] };
}

/** Every module specifier a source loads at runtime, static or dynamic. */
function specifiersOf(source: string): string[] {
  const { static: staticSpecifiers, dynamic } = specifiersByKind(source);
  return [...new Set([...staticSpecifiers, ...dynamic])];
}

/** Resolves a specifier to a module in the glob, the way Vite would. */
function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
  let candidate: string;
  if (specifier.startsWith('@/')) {
    candidate = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith('.')) {
    candidate = normalize(`${directoryOf(fromFile)}/${specifier}`);
  } else {
    return undefined;
  }
  for (const attempt of [
    candidate,
    `${candidate}.ts`,
    `${candidate}.vue`,
    `${candidate}.js`,
    `${candidate}/index.ts`,
    `${candidate}/index.js`,
  ]) {
    if (sources.has(attempt)) {
      return attempt;
    }
  }
  return undefined;
}

interface Graph {
  /** Webview-relative paths of every module in the entry's graph. */
  modules: Set<string>;
  /**
   * The subset a surface downloads up front: modules reachable through static
   * imports only. A dynamically imported module is a chunk fetched when it is
   * first used, which is how the non-base message catalogs stay out of the
   * initial payload.
   */
  staticModules: Set<string>;
  /** Bare specifiers (npm packages) the graph reaches. */
  packages: Set<string>;
}

function graphOf(entry: string): Graph {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (modules.has(file) || !sources.has(file)) {
      continue;
    }
    modules.add(file);
    for (const specifier of specifiersOf(sources.get(file)!)) {
      const resolved = resolveSpecifier(specifier, file);
      if (resolved) {
        queue.push(resolved);
      } else if (!specifier.startsWith('.') && !specifier.startsWith('@/')) {
        packages.add(specifier);
      }
    }
  }
  return { modules, staticModules: staticGraphOf(entry), packages };
}

/**
 * The modules reachable from `entry` through static imports alone: the ones a
 * surface has downloaded by the time its entry module has run. A module only a
 * dynamic `import()` reaches is a chunk fetched later.
 */
function staticGraphOf(entry: string): Set<string> {
  const reached = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (reached.has(file) || !sources.has(file)) {
      continue;
    }
    reached.add(file);
    for (const specifier of specifiersByKind(sources.get(file)!).static) {
      const resolved = resolveSpecifier(specifier, file);
      if (resolved) {
        queue.push(resolved);
      }
    }
  }
  return reached;
}

/** The `@vscode-elements/elements` components an entry registers. */
function registeredElements(entry: string): string[] {
  const elements = new Set<string>();
  for (const specifier of specifiersOf(sources.get(entry) ?? '')) {
    const element = ELEMENT_MODULE.exec(specifier);
    if (element) {
      elements.add(element[1]);
    }
  }
  return [...elements].sort();
}

/** The `<vscode-*>` custom elements rendered anywhere in a module graph. */
function renderedElements(modules: Iterable<string>): Set<string> {
  const rendered = new Set<string>();
  for (const file of modules) {
    for (const match of (sources.get(file) ?? '').matchAll(/<(vscode-[a-z0-9-]+)/g)) {
      rendered.add(match[1]);
    }
  }
  return rendered;
}

const graphs = new Map(SURFACES.map((surface) => [surface.name, graphOf(surface.entry)]));

describe('webview entry per surface', () => {
  it('boots each surface from its own document and entry module', () => {
    for (const surface of SURFACES) {
      const document = html.get(surface.html);
      expect(document, `${surface.html} is missing`).toBeDefined();
      const scripts = [...document!.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1]);
      expect(scripts).toEqual([`/${surface.entry}`]);
    }
  });

  it('mounts the surface root from its own entry', () => {
    for (const surface of SURFACES) {
      const graph = graphs.get(surface.name)!;
      expect([...graph.modules]).toContain(surface.root);
      const resolved = specifiersOf(sources.get(surface.entry) ?? '').map((specifier) =>
        resolveSpecifier(specifier, surface.entry),
      );
      expect(resolved).toContain(surface.root);
    }
  });

  it('keeps App.vue, the router and vue-router out of every panel entry', () => {
    for (const surface of SURFACES) {
      const graph = graphs.get(surface.name)!;
      if (surface.name === 'dashboard') {
        continue;
      }
      for (const file of graph.modules) {
        const leaked = DASHBOARD_SHELL.find((shell) => shell.pattern.test(file));
        expect(leaked, `${surface.name} reaches ${leaked?.label} through ${file}`).toBeUndefined();
      }
      for (const dependency of graph.packages) {
        expect(FORBIDDEN_PACKAGES, `${surface.name} loads ${dependency}`).not.toContain(dependency);
      }
      // Each panel carries its own root and never another panel's.
      const panels = PANEL_ROOTS.filter((panel) => panel !== surface.root);
      for (const panel of panels) {
        expect([...graph.modules]).not.toContain(panel);
      }
    }
  });

  it('keeps the standalone panels out of the dashboard entry', () => {
    const dashboard = graphs.get('dashboard')!;
    expect([...dashboard.modules]).toContain('src/App.vue');
    expect([...dashboard.modules]).toContain('src/router/index.ts');
    // The dashboard is the surface that has (and needs) the router.
    expect([...dashboard.packages]).toContain('vue-router');
    for (const panel of PANEL_ROOTS) {
      expect([...dashboard.modules]).not.toContain(panel);
    }
  });

  it('registers exactly the custom elements each surface renders', () => {
    for (const surface of SURFACES) {
      const graph = graphs.get(surface.name)!;
      const registered = registeredElements(surface.entry);
      // The expected list in this test, the entry's imports, and what the
      // surface actually renders have to agree — in both directions, so a
      // registration the surface never renders and a rendered element nobody
      // registers are both failures.
      expect(registered).toEqual([...surface.elements].sort());
      expect([...renderedElements(graph.modules)].sort()).toEqual([...surface.elements].sort());
    }
  });

  it('registers every custom element the webview renders somewhere', () => {
    const union = new Set(SURFACES.flatMap((surface) => registeredElements(surface.entry)));
    expect([...union].sort()).toEqual([...VSCODE_ELEMENT_TAGS].sort());
  });
});

/**
 * The message catalogs are the largest single item in the chunk every surface
 * downloads (see `webview/vite.config.mts` for the same assertion over the built
 * bundle). These pin the split: the base catalog is bundled everywhere, the
 * other is a dynamic import in `src/i18n/locales.ts` — and nothing else.
 */
describe('locale catalogs across the surface entries', () => {
  it('ships the base catalog and only the base catalog statically', () => {
    for (const surface of SURFACES) {
      const graph = graphs.get(surface.name)!;
      const staticCatalogs = [...graph.staticModules].map(catalogLocale).filter(Boolean);
      expect(staticCatalogs, `${surface.name} bundles more than the base catalog`).toEqual([BASE_LOCALE]);
      // It is in the graph through a static import, not merely through the lazy
      // loader in `i18n/locales.ts` (which is a dynamic edge).
      expect([...graph.modules]).toContain(`src/i18n/${BASE_LOCALE}.json`);
    }
  });

  it('reaches every other catalog only through the dynamic loader', () => {
    const loader = 'src/i18n/locales.ts';
    expect(sources.has(loader), `${loader} is missing`).toBe(true);
    const source = sources.get(loader)!;
    const kinds = specifiersByKind(source);
    const lazy = kinds.dynamic
      .map((specifier) => resolveSpecifier(specifier, loader))
      .filter((file): file is string => file !== undefined)
      .filter((file) => catalogLocale(file) !== BASE_LOCALE)
      .sort();
    // Every non-base catalog has a lazy entry, so adding a language to the
    // `Locale` union without a loader fails here rather than at runtime. The
    // base catalog is registered lazily too (the registry lists every locale),
    // but it is also imported statically by `src/i18n/index.ts` — which is what
    // puts it in the bundle, and which the per-surface assertion below and the
    // build assertion in `vite.config.mts` both hold.
    expect(lazy).toEqual(
      CATALOG_LOCALES.filter((locale) => locale !== BASE_LOCALE)
        .map((locale) => `src/i18n/${locale}.json`)
        .sort(),
    );
    // Dynamic, and *only* dynamic: a static import here would put the catalog
    // in the shared chunk all three surfaces download.
    expect(
      kinds.static
        .map((specifier) => resolveSpecifier(specifier, loader))
        .filter((file): file is string => file !== undefined)
        .map(catalogLocale)
        .filter(Boolean),
    ).toEqual([]);
    for (const surface of SURFACES) {
      const graph = graphs.get(surface.name)!;
      for (const file of lazy) {
        expect([...graph.staticModules], `${surface.name} statically bundles ${file}`).not.toContain(file);
      }
    }
  });

  it('imports the catalogs from one place', () => {
    // A second static import of a catalog anywhere else is how the split would
    // silently come back: it would re-enter that module's surface bundle.
    for (const [file, source] of sources) {
      if (file === 'src/i18n/index.ts' || file === 'src/i18n/locales.ts') {
        continue;
      }
      for (const specifier of specifiersByKind(source).static) {
        const resolved = resolveSpecifier(specifier, file);
        expect(resolved && catalogLocale(resolved), `${file} imports ${specifier} statically`).toBeUndefined();
      }
    }
  });
});
