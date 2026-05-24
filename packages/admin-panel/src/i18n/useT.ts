import { useLanguageStore } from '../store/language.js';
import { translations, type TranslationKey } from './translations.js';

/**
 * Hook: gibt eine Übersetzungsfunktion t() zurück.
 * Verwendung: const t = useT(); t('action_save') → 'Save' / 'Speichern'
 */
export function useT() {
  const lang = useLanguageStore((s) => s.lang);
  return (key: TranslationKey): string => translations[lang][key] ?? translations.de[key];
}
