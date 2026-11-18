/**
 * 9.4: short device label for the sessions list (Settings → Sicherheit), from a
 * session's User-Agent. No imports — unit-tested with `node --test`.
 */
const BROWSERS: Array<[RegExp, string]> = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
  [/coremail-cli|CoreMail-CLI/i, 'Admin-CLI'],
  [/curl\//i, 'curl'],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/iPhone|iPad|iOS/, 'iOS'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

const match = (ua: string, table: Array<[RegExp, string]>): string | null => table.find(([re]) => re.test(ua))?.[1] ?? null;

/** "Firefox · Windows", "Safari · iOS", or "Unbekanntes Gerät". */
export function describeUserAgent(ua: string | null | undefined): string {
  const s = ua ?? '';
  const parts = [match(s, BROWSERS), match(s, SYSTEMS)].filter((x): x is string => !!x);
  return parts.length > 0 ? parts.join(' · ') : 'Unbekanntes Gerät';
}
