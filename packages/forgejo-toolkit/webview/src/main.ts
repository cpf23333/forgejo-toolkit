import { createApp } from 'vue';
import App from './App.vue';
import { createI18nInstance } from './i18n';
import '@vscode-elements/elements/dist/bundled.js';
import './styles/global.css';

const i18n = createI18nInstance();

createApp(App).use(i18n).mount('#app');
