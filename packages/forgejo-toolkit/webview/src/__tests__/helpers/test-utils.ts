import { config, mount, type ComponentMountingOptions } from '@vue/test-utils';
import { createAppRouter } from '../../router';
import { createI18nInstance, type Locale } from '../../i18n';
import { VSCODE_ELEMENT_STUBS } from './vscodeElements';
import type { Component } from 'vue';
import en from '../../i18n/en.json';
import zh from '../../i18n/zh.json';

export function createTestRouter() {
  return createAppRouter();
}

/**
 * Builds an i18n instance with the requested language already on screen.
 *
 * The webview ships only the base catalog and loads the others on demand (see
 * `src/i18n/locales.ts`), but a component test mounts synchronously: a test that
 * asks for `zh` has to start in Chinese, not one async chunk later, and a test
 * that flips `i18n.global.locale.value = 'zh'` by hand has to find the catalog
 * there. Handing the catalogs to the factory is what keeps every existing
 * `createTestI18n('zh')` call site synchronous and unchanged. The tests that
 * care about the *lazy load* itself call `applyLocale` on a base-only instance
 * (`src/i18n/__tests__/localeCatalog.test.ts`).
 */
export function createTestI18n(locale: Locale = 'zh') {
  return createI18nInstance(locale, { en, zh });
}

export function mockVSCodeApi() {
  if (typeof window === 'undefined') {
    return;
  }

  (window as any).__FORGEJO_TOOLKIT_CONFIG__ = {
    vscodeVersion: '1.90.0',
  };

  if (!(window as any).acquireVsCodeApi) {
    (window as any).acquireVsCodeApi = () => ({
      postMessage: vi.fn(),
      getState: vi.fn(() => undefined),
      setState: vi.fn(),
    });
  }
}

export function stubVSCodeElements() {
  // One list, shared with the setup file: the tags the webview renders are
  // declared in ./vscodeElements.ts and kept in step with the sources by
  // ./vscodeElements.test.ts.
  config.global.stubs = {
    ...config.global.stubs,
    ...VSCODE_ELEMENT_STUBS,
  };
}

export function mountWithPlugins<T extends Component>(component: T, options: ComponentMountingOptions<T> = {}) {
  const router = createTestRouter();
  const i18n = createTestI18n();

  return mount(component, {
    global: {
      plugins: [router, i18n],
    },
    ...options,
  });
}
