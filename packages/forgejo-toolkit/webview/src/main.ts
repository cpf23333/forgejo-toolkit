import { createApp } from 'vue';
import App from './App.vue';
import OnboardingPanel from './OnboardingPanel.vue';
import { createI18nInstance } from './i18n';
import { createAppRouter } from './router';
import '@vscode-elements/elements/dist/bundled.js';
import './styles/global.css';

const i18n = createI18nInstance();

function isPanelMode(): boolean {
  return Boolean((window as unknown as Record<string, boolean>).__FORGEJO_TOOLKIT_PANEL_MODE__);
}

if (isPanelMode()) {
  createApp(OnboardingPanel).use(i18n).mount('#app');
} else {
  const router = createAppRouter();
  createApp(App).use(i18n).use(router).mount('#app');
}
