import { createApp } from 'vue';
import App from './App.vue';
import { createI18nInstance } from './i18n';
import { createAppRouter } from './router';
import '@vscode-elements/elements/dist/bundled.js';
import './styles/global.css';

const i18n = createI18nInstance();
const router = createAppRouter();

createApp(App).use(i18n).use(router).mount('#app');
