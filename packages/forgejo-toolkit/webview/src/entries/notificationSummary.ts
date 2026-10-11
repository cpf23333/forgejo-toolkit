// Entry point of the notification-summary panel (`notificationSummary.html`).
//
// It renders `NotificationSummaryPanel.vue` and nothing else, so it registers
// exactly the custom elements that surface renders: the buttons for the single
// regenerate and for the settings destination. The dashboard's elements (the tree,
// the context menu, the select, …), the other panels' roots and the dashboard shell
// (`App.vue`, the router) are not reachable from here at all;
// `src/__tests__/entryGraph.test.ts` and the assertion in `webview/vite.config.mts`
// pin that.
import '@vscode-elements/elements/dist/vscode-button/index.js';
import { mountSurface } from '../boot';
import NotificationSummaryPanel from '../NotificationSummaryPanel.vue';

void mountSurface(NotificationSummaryPanel);
