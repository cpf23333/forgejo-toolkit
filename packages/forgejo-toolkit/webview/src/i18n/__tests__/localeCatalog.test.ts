import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundledLocale } from '../locales';
import en from '../en.json';
import zh from '../zh.json';

/**
 * Pins the split between the catalog every surface ships and the one that
 * arrives as a chunk.
 *
 * `webview/vite.config.mts` asserts the same property over the built bundle (a
 * surface whose static graph carries a non-base catalog fails the build) and
 * `src/__tests__/entryGraph.test.ts` asserts it over the import graph. This test
 * is the one that exercises the split's behaviour: what a switch does while the
 * catalog is in flight, and that the fallback is English text rather than a raw
 * key.
 *
 * The loaded catalogs are process-wide module state (one catalog is fetched once
 * per webview process, by design), so the lazy loader is replaced with a
 * deferred this file resolves by hand. That makes every test's "not loaded yet"
 * and "arrived" states exact instead of an accident of test order — the real
 * `zh.json` is still imported below, and the deferred resolves with it.
 */

interface PendingCatalog {
  resolve: () => void;
  reject: (error: Error) => void;
}

const deferreds: PendingCatalog[] = [];

vi.mock('../locales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../locales')>();
  return {
    ...actual,
    localeCatalogLoaders: {
      en: () => import('../en.json'),
      zh: () =>
        new Promise<{ default: Record<string, unknown> }>((resolve, reject) => {
          // Resolved or rejected by the test, so the "in flight" window is a
          // fact the test controls rather than a race with the module graph.
          deferreds.push({
            resolve: () => resolve({ default: zh as Record<string, unknown> }),
            reject,
          });
        }),
    },
  };
});

/** Loads a fresh copy of the module graph, with no catalog loaded but the base. */
async function freshI18n() {
  vi.resetModules();
  const mod = await import('../index');
  return { mod, i18n: mod.createI18nInstance(mod.baseLocale) };
}

/** The locale the instance is actually rendering in. */
function rendered(i18n: { global: { locale: unknown } }): string {
  return (i18n.global.locale as { value: string }).value;
}

/** A leaf message from a loaded catalog, by dotted key. */
function leaf(catalog: unknown, path: string): string {
  let current: unknown = catalog;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) {
      throw new Error(`no message at ${path}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current !== 'string') {
    throw new Error(`${path} is not a message`);
  }
  return current;
}

/** A leaf key whose two translations differ, so it proves which one rendered. */
const KEY = 'common.confirm';
const ENGLISH = leaf(en, KEY);
const CHINESE = leaf(zh, KEY);

afterEach(() => {
  deferreds.length = 0;
  vi.restoreAllMocks();
});

describe('locale catalog loading', () => {
  it('starts with exactly the base catalog', async () => {
    const { mod } = await freshI18n();
    expect(mod.baseLocale).toBe('en');
    // The boot locale is the base locale, so a surface that boots without a
    // host-supplied locale never needs a catalog that has to be fetched.
    expect(mod.defaultLocale).toBe(mod.baseLocale);
    expect(mod.loadedMessages()).toEqual({ en });
    expect(mod.isCatalogLoaded(mod.baseLocale)).toBe(true);
    expect(mod.isCatalogLoaded('zh')).toBe(false);
  });

  it('describes the catalogs the build has to split', () => {
    // The loaders are the specifier list Vite turns into one chunk per
    // language; `bundledLocale` is what the i18n module and the build
    // assertions use to recognise a catalog module.
    expect(bundledLocale('/app/src/i18n/en.json')).toBe('en');
    expect(bundledLocale('D:\\app\\src\\i18n\\zh.json')).toBe('zh');
    expect(bundledLocale('/app/src/i18n/index.ts')).toBeUndefined();
    expect(bundledLocale('/app/src/views/Dashboard.vue')).toBeUndefined();
  });

  it('keeps rendering the base language until the other catalog is in place', async () => {
    const { mod, i18n } = await freshI18n();
    expect(ENGLISH).not.toBe(CHINESE);

    const pending = mod.applyLocale(i18n, 'zh');
    expect(deferreds).toHaveLength(1);
    // The instance still renders the base language: the chunk has not landed.
    expect(rendered(i18n)).toBe(mod.baseLocale);
    expect(i18n.global.t(KEY)).toBe(ENGLISH);

    deferreds[0].resolve();
    await pending;
    expect(rendered(i18n)).toBe('zh');
    expect(i18n.global.t(KEY)).toBe(CHINESE);
    expect(mod.isCatalogLoaded('zh')).toBe(true);
  });

  it('renders the base catalog, not the key, before any switch', async () => {
    const { mod, i18n } = await freshI18n();
    // The state a surface boots in: one catalog loaded, and every key resolves
    // to text. A switch that published the locale before its catalog would
    // render `common.confirm` here instead.
    expect(i18n.global.fallbackLocale.value).toBe(mod.baseLocale);
    expect(i18n.global.t(KEY)).toBe(ENGLISH);
  });

  it('switches again without fetching, once the catalog is cached', async () => {
    const { mod, i18n } = await freshI18n();
    const first = mod.applyLocale(i18n, 'zh');
    deferreds[0].resolve();
    await first;
    await mod.applyLocale(i18n, 'en');
    expect(rendered(i18n)).toBe('en');
    // The second switch to `zh` must not go back to the loader.
    await mod.applyLocale(i18n, 'zh');
    expect(rendered(i18n)).toBe('zh');
    expect(deferreds).toHaveLength(1);
  });

  it('keeps the previous language when a catalog cannot be loaded', async () => {
    const { mod, i18n } = await freshI18n();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pending = mod.applyLocale(i18n, 'zh');
    deferreds[0].reject(new Error('chunk offline'));
    await expect(pending).resolves.toBeUndefined();

    expect(rendered(i18n)).toBe(mod.baseLocale);
    expect(i18n.global.t(KEY)).toBe(ENGLISH);
    expect(mod.isCatalogLoaded('zh')).toBe(false);
    expect(consoleError).toHaveBeenCalled();
  });

  it('translates every base key in every other catalog', async () => {
    const { mod } = await freshI18n();
    // A lazy catalog with a hole in it would render the base language inside
    // otherwise-translated UI: the fallback hides that, but it is still a bug.
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    const pending = mod.loadLocaleMessage('zh');
    deferreds[0].resolve();
    await pending;
    expect(mod.isCatalogLoaded('zh')).toBe(true);
  });

  it('keeps the tag and the resolver for the locales that exist', async () => {
    const { mod } = await freshI18n();
    expect(mod.localeTag('en')).toBe('en');
    expect(mod.localeTag('zh')).toBe('zh-CN');
    expect(mod.resolveLocale('zh-CN')).toBe('zh');
    expect(mod.resolveLocale('en-US')).toBe('en');
    expect(mod.resolveLocale('de')).toBe('en');
  });
});
