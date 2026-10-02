import { config } from '@vue/test-utils';
import { vi } from 'vitest';
import { installNodeIteratorShimIfNeeded } from './helpers/happyDomNodeIterator';
import { VSCODE_ELEMENT_STUBS } from './helpers/vscodeElements';

// Installed here, and not from a test helper, because DOMPurify captures
// `document.createNodeIterator` once at module-init time: the shim has to be in
// place before any test module imports `dompurify`, and setup files run before
// the test module graph. happy-dom's own `NodeIterator` has neither the DOM
// Standard's pre-remove steps nor its candidate pointer, which makes DOMPurify
// stop sanitizing after the first removed node; see
// `helpers/happyDomNodeIterator.ts`. jsdom's own implementation is left alone —
// the differential check forces the shim over it with
// `FORGEJO_TOOLKIT_FORCE_NODE_ITERATOR_SHIM=1`, and the environment stays jsdom
// for the unrelated reason recorded in `webview/vitest.config.mts`.
installNodeIteratorShimIfNeeded();

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
