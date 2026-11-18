/** 9.4: readable texts of API errors that need a computed part. Pure — unit-tested with `node --test`. */
import { translations, type Lang } from '../i18n/translations.ts';

/** Text of a 413 in the UI language: the limit in MB when the server names it. */
export function tooLargeText(maxBytes: unknown, lang: Lang = 'de'): string {
  const texts = translations[lang] ?? translations.de;
  const mb = typeof maxBytes === 'number' && maxBytes > 0 ? Math.max(1, Math.floor(maxBytes / (1024 * 1024))) : null;
  return mb ? texts.compose_too_large_max.replace('{mb}', String(mb)) : texts.compose_too_large;
}
