import { createApp } from 'vue';
import App from './App.vue';
import OnboardingPanel from './OnboardingPanel.vue';
import PullReviewCommentPanel from './PullReviewCommentPanel.vue';
import { createI18nInstance, defaultLocale } from './i18n';
import { createAppRouter } from './router';
import './types/config';
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-checkbox/index.js';
import '@vscode-elements/elements/dist/vscode-context-menu/index.js';
import '@vscode-elements/elements/dist/vscode-context-menu-item/index.js';
import '@vscode-elements/elements/dist/vscode-icon/index.js';
import '@vscode-elements/elements/dist/vscode-option/index.js';
import '@vscode-elements/elements/dist/vscode-progress-ring/index.js';
import '@vscode-elements/elements/dist/vscode-single-select/index.js';
import '@vscode-elements/elements/dist/vscode-textfield/index.js';
import '@vscode-elements/elements/dist/vscode-tree/index.js';
import '@vscode-elements/elements/dist/vscode-tree-item/index.js';
import '@vscode/codicons/dist/codicon.css';
import './styles/global.css';

const config = window.__FORGEJO_TOOLKIT_CONFIG__;
const panelMode = config?.panelMode;
const panelLocale = config?.locale ?? defaultLocale;
const i18n = createI18nInstance(panelMode ? panelLocale : defaultLocale);

if (panelMode === 'onboarding') {
  createApp(OnboardingPanel).use(i18n).mount('#app');
} else if (panelMode === 'pullReviewComment') {
  createApp(PullReviewCommentPanel).use(i18n).mount('#app');
} else {
  const router = createAppRouter();
  createApp(App).use(i18n).use(router).mount('#app');
}
