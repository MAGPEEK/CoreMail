import { useLanguageStore } from '../store/language.js';
import { translations, type TranslationKey } from './translations.js';

export function useT() {
  const lang = useLanguageStore((s) => s.lang);
  return (key: TranslationKey): string => translations[lang][key] ?? translations.de[key];
}

/** Translation outside React components (toasts, module-level helpers). */
export function translate(key: TranslationKey): string {
  const lang = useLanguageStore.getState().lang;
  return translations[lang]?.[key] ?? translations.de[key];
}

/** Replaces `{name}` placeholders. */
export function fmt(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
