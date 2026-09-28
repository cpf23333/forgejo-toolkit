import { config } from '@vue/test-utils';
import { vi } from 'vitest';
import { VSCODE_ELEMENT_STUBS } from './helpers/vscodeElements';

if (typeof window !== 'undefined') {
  (window as any).__FORGEJO_TOOLKIT_CONFIG__ = {
    vscodeVersion: '1.90.0',
  };

  (window as any).acquireVsCodeApi = () => ({
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  });
}

// Stubs for the `<vscode-*>` elements the webview renders. They are compiled as
// custom elements (`vite.config.mts` sets `isCustomElement` for every `vscode-`
// tag), so Vue never resolves them as components and these entries do not
// actually replace them today; what keeps the list complete is the drift guard
// in `__tests__/helpers/vscodeElements.test.ts`. The stub markup is kept so a
// tag that ever becomes a real component is already stubbed rather than
// rendered for real.
config.global.stubs = {
  ...config.global.stubs,
  ...VSCODE_ELEMENT_STUBS,
};
