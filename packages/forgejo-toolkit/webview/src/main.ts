import { createApp } from 'vue';
import App from './App.vue';
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
import '@vscode-elements/elements/dist/vscode-radio/index.js';
import '@vscode-elements/elements/dist/vscode-radio-group/index.js';
import '@vscode-elements/elements/dist/vscode-single-select/index.js';
import '@vscode-elements/elements/dist/vscode-textfield/index.js';
import '@vscode-elements/elements/dist/vscode-tree/index.js';
import '@vscode-elements/elements/dist/vscode-tree-item/index.js';
import './styles/global.css';

const config = window.__FORGEJO_TOOLKIT_CONFIG__;
const panelMode = config?.panelMode;
const panelLocale = config?.locale ?? defaultLocale;
const i18n = createI18nInstance(panelMode ? panelLocale : defaultLocale);

// The dashboard is the common case and stays static; the two standalone panels are
// imported on demand, so opening one of them (or the dashboard) does not download
// the other two.
async function bootstrap(): Promise<void> {
  if (panelMode === 'onboarding') {
    const { default: OnboardingPanel } = await import('./OnboardingPanel.vue');
    createApp(OnboardingPanel).use(i18n).mount('#app');
    return;
  }
  if (panelMode === 'pullReviewComment') {
    const { default: PullReviewCommentPanel } = await import('./PullReviewCommentPanel.vue');
    createApp(PullReviewCommentPanel).use(i18n).mount('#app');
    return;
  }
  const router = createAppRouter();
  createApp(App).use(i18n).use(router).mount('#app');
}

void bootstrap();
