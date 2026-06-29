import { createI18n } from 'vue-i18n';
import en from './en.json';
import zh from './zh.json';

export type Locale = 'en' | 'zh';

export const messages = {
  en,
  zh,
};

export const defaultLocale: Locale = 'zh';

export function createI18nInstance(locale: Locale = defaultLocale) {
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'en',
    messages,
    missingWarn: false,
    fallbackWarn: false,
  });
}

export function resolveLocale(vscodeLanguage: string): Locale {
  const lang = vscodeLanguage.toLowerCase();
  if (lang.startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}
