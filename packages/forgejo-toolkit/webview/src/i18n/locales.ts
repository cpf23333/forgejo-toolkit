import type { Locale } from './index';

/**
 * The message catalogs, one module per language.
 *
 * `en.json` is the fallback catalog and is imported statically (`./index.ts`),
 * so a surface always has a complete set of strings: a key the active catalog
 * does not carry renders in English rather than as its raw key name.
 *
 * `zh.json` is deliberately **not** imported here. Every non-base catalog is
 * loaded through a dynamic `import()` when its language is selected, which is
 * what keeps it out of the bundle a surface downloads up front. The specifiers
 * are written out literally so Vite emits one chunk per catalog; interpolating
 * the locale into a template (`import(\`./${locale}.json\`)`) is not a form the
 * bundler resolves to a static chunk.
 *
 * Adding a language means a new entry here plus its `Locale` member — see
 * `bundledLocale` below, which both the i18n module and the build-time
 * assertions read.
 */
export const localeCatalogLoaders: Record<Locale, () => Promise<{ default: Record<string, unknown> }>> = {
  en: () => import('./en.json'),
  zh: () => import('./zh.json'),
};

/**
 * The locale a module id belongs to when it *is* a bundled catalog module
 * (`…/i18n/zh.json` in a built chunk, `./zh.json` in a source import).
 *
 * Both the i18n module (to find its own dynamic import) and
 * `webview/vite.config.mts` (to assert which catalogs a surface bundles) derive
 * the catalog paths from this, so a new language does not have to be added in
 * several places.
 */
export function bundledLocale(moduleId: string): Locale | undefined {
  const match = /(?:^|[/\\])([a-z]{2})\.json$/.exec(moduleId);
  const locale = match?.[1];
  return locale && locale in localeCatalogLoaders ? (locale as Locale) : undefined;
}
