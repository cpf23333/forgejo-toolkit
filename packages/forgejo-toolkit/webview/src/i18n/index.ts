import { createI18n } from 'vue-i18n';
import en from './en.json';
import zh from './zh.json';

export type Locale = 'en' | 'zh';

export const messages = {
  en,
  zh,
};

export const defaultLocale: Locale = 'zh';

/**
 * BCP-47 spelling of an app locale, for `<html lang>` and the `toLocale*` /
 * `Intl` formatters: without it the host browser formats dates and numbers with
 * whatever locale it is running in, which does not match the UI language.
 */
export function localeTag(locale: Locale): string {
  return locale === 'zh' ? 'zh-CN' : 'en';
}

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
