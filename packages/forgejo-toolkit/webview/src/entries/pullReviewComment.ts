// Entry point of the standalone pull request review comment editor
// (`pullReviewComment.html`).
//
// It renders `PullReviewCommentPanel.vue` and nothing else, so it registers
// exactly the custom elements that surface renders: the editor's own buttons and
// review-event radios (`views/PullReviewCommentEditor.vue`) and the icons the
// markdown editor embeds (`components/EasyMdeEditor.vue`). The dashboard's
// elements (the tree, the context menu, the select, …) and its shell (`App.vue`,
// the router) are not reachable from here at all;
// `src/__tests__/entryGraph.test.ts` and the assertion in
// `webview/vite.config.ts` pin that.
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-icon/index.js';
import '@vscode-elements/elements/dist/vscode-radio/index.js';
import '@vscode-elements/elements/dist/vscode-radio-group/index.js';
import { mountSurface } from '../boot';
import PullReviewCommentPanel from '../PullReviewCommentPanel.vue';

mountSurface(PullReviewCommentPanel);
