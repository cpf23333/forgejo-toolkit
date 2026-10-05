// Entry point of the settings tab (`settings.html`).
//
// It renders `SettingsPanel.vue` and nothing else, so it registers exactly the
// custom elements that surface renders: the page's own buttons, its checkboxes,
// the two selects (the language/transport dropdowns and the narrow group
// selector), their options and its text fields — plus the icon `ModalDialog`
// draws. The dashboard's elements (the tree, the context menu, the progress
// ring) and the dashboard shell (`App.vue`, the router) are not reachable from
// here at all; `src/__tests__/entryGraph.test.ts` and the assertion in
// `webview/vite.config.mts` pin that.
//
// The page used to be one of the sidebar router's views, which is why this
// document is a change of home rather than only a change of layout: the sidebar
// application no longer renders `Settings.vue` at all
// (`docs/design/settings-page.md` §9.3, §9.5 rule 3).
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-checkbox/index.js';
import '@vscode-elements/elements/dist/vscode-icon/index.js';
import '@vscode-elements/elements/dist/vscode-option/index.js';
import '@vscode-elements/elements/dist/vscode-single-select/index.js';
import '@vscode-elements/elements/dist/vscode-textfield/index.js';
import { mountSurface } from '../boot';
import SettingsPanel from '../SettingsPanel.vue';

void mountSurface(SettingsPanel);
