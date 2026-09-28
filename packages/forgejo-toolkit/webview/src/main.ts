// Entry point of the sidebar dashboard (`index.html`).
//
// The two standalone panels are separate entries
// (`src/entries/onboarding.ts`, `src/entries/pullReviewComment.ts`) loaded by
// their own HTML documents, so this entry never reaches them — and they never
// reach `App.vue`, the router, or the elements only the dashboard renders.
// `src/__tests__/entryGraph.test.ts` and the assertion in `webview/vite.config.mts`
// pin that.
//
// One `@vscode-elements/elements` module per component the dashboard actually
// renders, imported directly (the project rule). `vscode-context-menu-item` is
// deliberately absent: `vscode-context-menu` imports and registers it itself.
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-checkbox/index.js';
import '@vscode-elements/elements/dist/vscode-context-menu/index.js';
import '@vscode-elements/elements/dist/vscode-icon/index.js';
import '@vscode-elements/elements/dist/vscode-option/index.js';
import '@vscode-elements/elements/dist/vscode-progress-ring/index.js';
import '@vscode-elements/elements/dist/vscode-single-select/index.js';
import '@vscode-elements/elements/dist/vscode-textfield/index.js';
import '@vscode-elements/elements/dist/vscode-tree/index.js';
import '@vscode-elements/elements/dist/vscode-tree-item/index.js';
import App from './App.vue';
import { mountSurface } from './boot';
import { appRouterKey } from './composables/useAppRouter';
import { createAppRouter } from './router';

void mountSurface(App, (app) => {
  const router = createAppRouter();
  app.use(router);
  // `useAppState` reaches the router through this key rather than through
  // vue-router's `useRouter()`: the composable is shared with the two
  // standalone panels, and importing `useRouter` would put the router
  // implementation into their entry bundles (see `useAppRouter`).
  app.provide(appRouterKey, router);
});
