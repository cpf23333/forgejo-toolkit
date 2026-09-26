// Entry point of the standalone setup wizard (`onboarding.html`).
//
// It renders `OnboardingPanel.vue` and nothing else, so it registers exactly the
// custom elements that surface renders — the wizard's own
// (`views/Onboarding.vue`) plus its inline import preview
// (`views/ImportPreview.vue`). The dashboard's elements (the tree, the context
// menu, the progress ring, …) and its shell (`App.vue`, the router) are not
// reachable from here at all; `src/__tests__/entryGraph.test.ts` and the
// assertion in `webview/vite.config.ts` pin that.
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-checkbox/index.js';
import '@vscode-elements/elements/dist/vscode-icon/index.js';
import '@vscode-elements/elements/dist/vscode-option/index.js';
import '@vscode-elements/elements/dist/vscode-single-select/index.js';
import '@vscode-elements/elements/dist/vscode-textfield/index.js';
import { mountSurface } from '../boot';
import OnboardingPanel from '../OnboardingPanel.vue';

mountSurface(OnboardingPanel);
