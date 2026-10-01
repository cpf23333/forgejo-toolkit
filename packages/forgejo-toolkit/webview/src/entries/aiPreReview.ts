// Entry point of the AI pre-review confirmation panel (`aiPreReview.html`).
//
// It renders `AiPreReviewPanel.vue` and nothing else, so it registers exactly the
// custom elements that surface renders: the checkboxes that select the
// candidates and the buttons that create or dismiss them. The dashboard's
// elements (the tree, the context menu, the select, …), the review-comment
// editor's radios and the dashboard shell (`App.vue`, the router) are not
// reachable from here at all; `src/__tests__/entryGraph.test.ts` and the
// assertion in `webview/vite.config.mts` pin that.
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-checkbox/index.js';
import { mountSurface } from '../boot';
import AiPreReviewPanel from '../AiPreReviewPanel.vue';

void mountSurface(AiPreReviewPanel);
