import { createApp } from 'vue';
import App from './App.vue';
import OnboardingPanel from './OnboardingPanel.vue';
import PullReviewCommentPanel from './PullReviewCommentPanel.vue';
import { createI18nInstance, defaultLocale } from './i18n';
import { createAppRouter } from './router';
import './types/config';
import '@vscode-elements/elements/dist/bundled.js';
import './styles/global.css';
import 'font-awesome/css/font-awesome.min.css';

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
