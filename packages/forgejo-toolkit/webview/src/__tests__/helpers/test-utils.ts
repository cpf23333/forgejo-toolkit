import { config, mount, type ComponentMountingOptions } from '@vue/test-utils';
import { createAppRouter } from '../../router';
import { createI18nInstance, type Locale } from '../../i18n';
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
  config.global.stubs = {
    ...config.global.stubs,
    'vscode-tree-item': {
      template: '<div data-stub="vscode-tree-item"><slot /></div>',
    },
    'vscode-tree': {
      template: '<div data-stub="vscode-tree"><slot /></div>',
    },
    'vscode-button': {
      template: '<button data-stub="vscode-button"><slot /></button>',
    },
    'vscode-icon': {
      template: '<span data-stub="vscode-icon" :class="$attrs.class"><slot /></span>',
    },
    'vscode-dropdown': {
      template: '<select data-stub="vscode-dropdown"><slot /></select>',
    },
    'vscode-option': {
      template: '<option data-stub="vscode-option"><slot /></option>',
    },
    'vscode-text-field': {
      template: '<input data-stub="vscode-text-field" />',
    },
    'vscode-text-area': {
      template: '<textarea data-stub="vscode-text-area" />',
    },
    'vscode-checkbox': {
      template: '<input type="checkbox" data-stub="vscode-checkbox" />',
    },
    'vscode-radio': {
      template: '<input type="radio" data-stub="vscode-radio" />',
    },
    'vscode-tabs': {
      template: '<div data-stub="vscode-tabs"><slot /></div>',
    },
    'vscode-tab-header': {
      template: '<div data-stub="vscode-tab-header"><slot /></div>',
    },
    'vscode-tab-panel': {
      template: '<div data-stub="vscode-tab-panel"><slot /></div>',
    },
    'vscode-tab': {
      template: '<div data-stub="vscode-tab"><slot /></div>',
    },
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
