/**
 * 9.4: date/time formatting by the user's regional settings (Settings → Region:
 * time zone, date format, 12/24 h, language) instead of the browser locale.
 * '' as time zone = the browser's zone. No imports — unit-tested with `node --test`.
 */
export type DateFormatPattern = 'dd.MM.yyyy' | 'yyyy-MM-dd' | 'MM/dd/yyyy' | 'd. MMM yyyy';

export interface RegionalSettings {
  language: string;
  timeZone: string;
  dateFormat: DateFormatPattern;
  timeFormat: '24h' | '12h';
}

const LOCALES: Record<string, string> = { de: 'de-DE', en: 'en-GB', es: 'es-ES', it: 'it-IT' };

export function localeOf(language: string): string {
  return LOCALES[language] ?? 'de-DE';
}

interface Parts { year: number; month: number; day: number; hour: number; minute: number }

const pad = (n: number) => String(n).padStart(2, '0');

/** Calendar fields of an instant in the zone ('' = browser zone). */
export function zonedParts(d: Date, timeZone: string): Parts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { year: out['year']!, month: out['month']!, day: out['day']!, hour: out['hour']! % 24, minute: out['minute']! };
}

export function formatDate(d: Date, r: RegionalSettings): string {
  const p = zonedParts(d, r.timeZone);
  switch (r.dateFormat) {
    case 'yyyy-MM-dd': return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    case 'MM/dd/yyyy': return `${pad(p.month)}/${pad(p.day)}/${p.year}`;
    case 'd. MMM yyyy': {
      const month = new Intl.DateTimeFormat(localeOf(r.language), { month: 'short', ...(r.timeZone ? { timeZone: r.timeZone } : {}) }).format(d);
      return `${p.day}. ${month.replace(/\.$/, '')} ${p.year}`;
    }
    default: return `${pad(p.day)}.${pad(p.month)}.${p.year}`;
  }
}

export function formatTime(d: Date, r: RegionalSettings): string {
  const p = zonedParts(d, r.timeZone);
  if (r.timeFormat === '24h') return `${pad(p.hour)}:${pad(p.minute)}`;
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${pad(p.minute)} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

export function formatDateTime(d: Date, r: RegionalSettings): string {
  return `${formatDate(d, r)} ${formatTime(d, r)}`;
}

function dayNumber(p: Parts): number {
  return Date.UTC(p.year, p.month - 1, p.day) / 86_400_000;
}

/** Message-list date: time today, `yesterdayLabel` yesterday, the date otherwise (all in the user's zone). */
export function formatListDate(d: Date, now: Date, r: RegionalSettings, yesterdayLabel: string): string {
  const diff = dayNumber(zonedParts(now, r.timeZone)) - dayNumber(zonedParts(d, r.timeZone));
  if (diff === 0) return formatTime(d, r);
  if (diff === 1) return yesterdayLabel;
  return formatDate(d, r);
}

/** "Montag, 09.03.2026 23:30" — weekday in the user's language and zone. */
export function formatLongDateTime(d: Date, r: RegionalSettings): string {
  const weekday = new Intl.DateTimeFormat(localeOf(r.language), { weekday: 'long', ...(r.timeZone ? { timeZone: r.timeZone } : {}) }).format(d);
  return `${weekday}, ${formatDateTime(d, r)}`;
}

/** Time zones offered in the settings (the runtime's list, the current value always included). */
export function timeZoneOptions(current: string): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const all = intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : ['UTC', 'Europe/Berlin', 'Europe/London', 'America/New_York'];
  return current && !all.includes(current) ? [current, ...all] : all;
}
