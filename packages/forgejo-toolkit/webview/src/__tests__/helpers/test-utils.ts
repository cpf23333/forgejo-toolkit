import { config, mount, type ComponentMountingOptions } from '@vue/test-utils';
import { createAppRouter } from '../../router';
import { createI18nInstance, type Locale } from '../../i18n';
import { VSCODE_ELEMENT_STUBS } from './vscodeElements';
import type { Component } from 'vue';

export function createTestRouter() {
  return createAppRouter();
}

export function createTestI18n(locale: Locale = 'zh') {
  return createI18nInstance(locale);
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
