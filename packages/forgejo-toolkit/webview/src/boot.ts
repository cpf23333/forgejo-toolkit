import { createApp, type App, type Component } from 'vue';
import { createI18nInstance, defaultLocale, localeTag, type Locale } from './i18n';
import './types/config';
import './styles/global.css';

/**
 * The locale one webview surface boots in.
 *
 * The host builds every standalone panel's HTML with the locale it resolved for
 * that panel (`panelMode` and `locale` in `__FORGEJO_TOOLKIT_CONFIG__`; see
 * `src/webview/content.ts`). The dashboard's HTML carries no `panelMode`, so it
 * keeps the source locale and `useAppState` switches it at runtime when the
 * host pushes `setLocale`.
 */
export function surfaceLocale(): Locale {
  const config = window.__FORGEJO_TOOLKIT_CONFIG__;
  return config?.panelMode ? (config.locale ?? defaultLocale) : defaultLocale;
}

/**
 * Mounts one webview surface on `#app`.
 *
 * Every surface (the sidebar dashboard and each standalone panel) goes through
 * here, so the boot contract lives in one place: the `locale` the host put in
 * `__FORGEJO_TOOLKIT_CONFIG__`, the `<html lang>` that has to follow it, and the
 * global stylesheet. `setup` is the surface's own extras — the dashboard
 * installs the router and provides it to `useAppRouter()`; the panels install
 * nothing, which is what keeps `App.vue` and the router out of their entry
 * bundles.
 */
export function mountSurface(component: Component, setup?: (app: App) => void): void {
  const locale = surfaceLocale();
  // The HTML ships `lang="en"`; screen readers and the browser pick their
  // language rules from it, so it has to follow the locale the surface actually
  // renders in. `useAppState` keeps it in sync when the locale changes at runtime.
  document.documentElement.lang = localeTag(locale);
  const app = createApp(component).use(createI18nInstance(locale));
  setup?.(app);
  app.mount('#app');
}
