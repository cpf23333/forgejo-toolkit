import { createI18n } from 'vue-i18n';
import en from './en.json';
import { localeCatalogLoaders } from './locales';

export type Locale = 'en' | 'zh';

/** A message catalog as this module handles it: loaded JSON, not yet typed. */
type Catalog = Record<string, unknown>;

/**
 * The catalog that is always bundled.
 *
 * Every i18n instance is created with this catalog and uses it as
 * `fallbackLocale`, so a key the active language does not translate renders in
 * English and never as its raw key name. It is also the base locale: `en.json`
 * is the smaller of the two catalogs.
 */
export const baseLocale: Locale = 'en';

/**
 * The locale a surface boots in when the host names none.
 *
 * This used to be `zh` — the webview mounted in Chinese and the host corrected
 * it after the first `initialState` round trip. Now that only the base catalog
 * ships with the bundle, guessing a non-base locale means both a flash of the
 * wrong language and a chunk fetch before the right one can render, so the boot
 * locale is the base locale and the host supplies the real one (`panelMode` and
 * `locale` in `__FORGEJO_TOOLKIT_CONFIG__`, or the pushed `initialState` /
 * `setLocale`).
 */
export const defaultLocale: Locale = baseLocale;

/**
 * The catalogs already loaded, by locale. `en` is present from the start: it is
 * a static import of this module.
 */
const catalogs: Partial<Record<Locale, Catalog>> = {
  [baseLocale]: en as Catalog,
};

/**
 * The message sets to hand to `createI18n`: the base catalog plus every
 * catalog loaded so far. `extra` adds catalogs a caller already has in hand
 * (the test helper does).
 *
 * A locale whose catalog is not supplied is simply absent, which makes
 * vue-i18n resolve its keys through `fallbackLocale` — English text, never a
 * raw key name.
 */
export function loadedMessages(extra?: Partial<Record<Locale, Catalog>>): Record<string, Catalog> {
  return { ...catalogs, ...extra } as Record<string, Catalog>;
}

/**
 * Whether a locale's catalog is in the bundle already, making a locale switch to
 * it synchronous.
 */
export function isCatalogLoaded(locale: Locale): boolean {
  return catalogs[locale] !== undefined;
}

/**
 * Loads a locale's catalog if it is not loaded yet.
 *
 * The base locale resolves immediately; every other one is a dynamic
 * `import()`, so the chunk is fetched the first time that language is selected
 * and reused from `catalogs` afterwards. A failed fetch is not fatal: the call
 * resolves with the catalog still missing, the previous language stays on
 * screen, and the base catalog keeps the UI from rendering raw key names.
 */
export async function loadLocaleMessage(locale: Locale): Promise<void> {
  if (catalogs[locale]) {
    return;
  }
  // The host may push no locale at all (the dashboard's `initialState` carries
  // a locale only when the view provider has resolved one), so the lookup is
  // guarded rather than trusted: an unknown locale is a no-op, not a crash.
  const load = localeCatalogLoaders[locale];
  if (!load) {
    return;
  }
  try {
    const catalog = await load();
    catalogs[locale] = catalog.default as Catalog;
  } catch (error) {
    console.error(`Failed to load the "${locale}" message catalog`, error);
  }
}

/**
 * The part of a composition-mode i18n context `applyLocale` switches.
 *
 * `useI18n()` hands back the composer itself, `createI18n(...)` hands back an
 * object whose `global` is that composer — both work here. Declared
 * structurally rather than named through vue-i18n's generics: the composer's
 * `locale` is a writable ref at runtime but is typed as a plain string in this
 * position, so every call site would otherwise repeat the same cast.
 */
interface LocaleRenderer {
  /** The language the next render resolves keys in. */
  locale: { value: string };
  setLocaleMessage(locale: string, message: unknown): void;
}

/**
 * Switches a live i18n context to `locale`, loading its catalog first.
 *
 * The caller hands over the composer (`i18n.global`) or the pieces of one
 * (`useI18n()` returns the composer's members rather than the composer).
 *
 * The catalog is applied before the locale changes, so a switch is atomic: the
 * UI renders in the previous language until the new catalog is in place and
 * then re-renders in the new one. Nothing in between can show a missing key,
 * and a failed fetch leaves the previous language untouched rather than
 * half-switching.
 *
 * The `await` is not always a wait: a catalog already in the bundle (the base
 * one, or one loaded earlier in the session) is applied without yielding.
 *
 * `shouldApply` is checked *after* the catalog lands and before anything is
 * applied, so a caller can drop a request that a newer one has superseded
 * instead of letting it drag the UI back to the language the user left.
 */
export async function applyLocale(
  renderer: LocaleRenderer | { global: LocaleRenderer } | undefined,
  locale: Locale,
  shouldApply?: () => boolean,
) {
  await loadLocaleMessage(locale);
  if (shouldApply && !shouldApply()) {
    return;
  }
  const composer = renderer && ('global' in renderer ? renderer.global : renderer);
  // `useI18n()` returns `undefined` when no i18n plugin is installed
  // (`useAppState.withoutRouter.test.ts` mounts that way), so a caller may hold
  // nothing to switch.
  const messages = catalogs[locale];
  if (!composer || !messages) {
    // The catalog is not there — a failed fetch, or no composer at all. The
    // locale is deliberately *not* published: naming a language whose messages
    // are missing would render keys through the fallback while every future
    // lookup paid for the miss, and the previous language is still fully
    // translated.
    return;
  }
  composer.setLocaleMessage(locale, messages);
  composer.locale.value = locale;
}

/**
 * BCP-47 spelling of an app locale, for `<html lang>` and the `toLocale*` /
 * `Intl` formatters: without it the host browser formats dates and numbers with
 * whatever locale it is running in, which does not match the UI language.
 */
export function localeTag(locale: Locale): string {
  return locale === 'zh' ? 'zh-CN' : 'en';
}

/**
 * Builds an i18n instance holding every catalog loaded so far.
 *
 * The return type is vue-i18n's own `I18n`, which is what a Vue app needs for
 * `app.use(...)`; the messages cast is the boundary between "JSON we loaded" and
 * the recursive message type vue-i18n expects.
 */
export function createI18nInstance(locale: Locale = defaultLocale, extra?: Partial<Record<Locale, Catalog>>) {
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: baseLocale,
    messages: loadedMessages(extra) as unknown as Record<string, Record<string, string>>,
    missingWarn: false,
    fallbackWarn: false,
  });
}

export function resolveLocale(vscodeLanguage: string): Locale {
  const lang = vscodeLanguage.toLowerCase();
  if (lang.startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}
