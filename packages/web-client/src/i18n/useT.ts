import { useLanguageStore } from '../store/language.js';
import { translations, type TranslationKey } from './translations.js';

export function useT() {
  const lang = useLanguageStore((s) => s.lang);
  return (key: TranslationKey): string => translations[lang][key] ?? translations.de[key];
}
