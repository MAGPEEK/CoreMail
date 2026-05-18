import { useLanguageStore } from '../store/language.js';
import { translations } from './translations.js';
export function useT() {
    const lang = useLanguageStore((s) => s.lang);
    return (key) => translations[lang][key] ?? translations.de[key];
}
