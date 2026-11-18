/**
 * 9.4: recurrence in the event form — smart presets derived from the chosen date
 * ("Jeden Dienstag", "Jeden 2. Dienstag des Monats", …) and the full editor model
 * (interval, weekdays, monthly by day or position, yearly, end never / after N /
 * on a date) ⇄ an RRULE value. Pure — unit-tested with `node --test`.
 */

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
export const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const JS_DAY: readonly Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WORKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR'];

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  MO: 'Montag', TU: 'Dienstag', WE: 'Mittwoch', TH: 'Donnerstag', FR: 'Freitag', SA: 'Samstag', SU: 'Sonntag',
};
const MONTH_LABEL = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const ORDINAL: Record<number, string> = { 1: 'ersten', 2: 'zweiten', 3: 'dritten', 4: 'vierten', [-1]: 'letzten' };

export type RecurrenceEnd =
  | { type: 'never' }
  | { type: 'count'; count: number }
  | { type: 'until'; date: string };

export interface RecurrenceModel {
  freq: Freq;
  interval: number;
  /** WEEKLY: the week days. */
  byDay: Weekday[];
  /** MONTHLY / YEARLY: on a day of the month, or on the n-th week day. */
  monthlyMode: 'day' | 'position';
  monthDay: number;
  /** 1..4 or -1 (last). */
  setPos: number;
  posDay: Weekday;
  /** YEARLY: 1..12. */
  month: number;
  end: RecurrenceEnd;
}

interface DateParts { y: number; m: number; d: number; weekday: Weekday }

function parts(date: string): DateParts {
  const [y, m, d] = date.split('-').map(Number);
  const js = new Date(Date.UTC(y!, m! - 1, d!));
  return { y: y!, m: m!, d: d!, weekday: JS_DAY[js.getUTCDay()]! };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Week of the month of a date: 1..4, or -1 when it is the last such week day (5th week). */
export function positionOf(date: string): number {
  const p = parts(date);
  const nth = Math.ceil(p.d / 7);
  return p.d + 7 > daysInMonth(p.y, p.m) && nth >= 4 ? -1 : nth;
}

/** Editor defaults for a start date: weekly on its week day, monthly on its day, yearly on its date. */
export function defaultModel(date: string, freq: Freq = 'WEEKLY'): RecurrenceModel {
  const p = parts(date);
  return {
    freq, interval: 1, byDay: [p.weekday], monthlyMode: 'day', monthDay: p.d,
    setPos: positionOf(date), posDay: p.weekday, month: p.m, end: { type: 'never' },
  };
}

export interface RecurrencePreset {
  id: string;
  label: string;
  rrule: string;
}

/** The presets offered for an event on `date` (YYYY-MM-DD). */
export function recurrencePresets(date: string): RecurrencePreset[] {
  const p = parts(date);
  const pos = positionOf(date);
  return [
    { id: 'daily', label: 'Jeden Tag', rrule: 'FREQ=DAILY' },
    { id: 'weekly', label: `Jeden ${WEEKDAY_LABEL[p.weekday]}`, rrule: `FREQ=WEEKLY;BYDAY=${p.weekday}` },
    { id: 'workdays', label: 'Jeden Arbeitstag', rrule: `FREQ=WEEKLY;BYDAY=${WORKDAYS.join(',')}` },
    { id: 'monthlyDay', label: `Am ${p.d}. Tag jedes Monats`, rrule: `FREQ=MONTHLY;BYMONTHDAY=${p.d}` },
    { id: 'monthlyPos', label: `Jeden ${ORDINAL[pos]} ${WEEKDAY_LABEL[p.weekday]} des Monats`, rrule: `FREQ=MONTHLY;BYDAY=${pos}${p.weekday}` },
    { id: 'yearly', label: `Jährlich am ${p.d}. ${MONTH_LABEL[p.m - 1]}`, rrule: `FREQ=YEARLY;BYMONTH=${p.m};BYMONTHDAY=${p.d}` },
  ];
}

/** RRULE value (without "RRULE:") of an editor model. */
export function buildRrule(model: RecurrenceModel): string {
  const parts: string[] = [`FREQ=${model.freq}`];
  if (model.interval > 1) parts.push(`INTERVAL=${Math.floor(model.interval)}`);
  if (model.freq === 'WEEKLY') {
    const days = WEEKDAYS.filter((d) => model.byDay.includes(d));
    if (days.length > 0) parts.push(`BYDAY=${days.join(',')}`);
  }
  if (model.freq === 'YEARLY') parts.push(`BYMONTH=${model.month}`);
  if (model.freq === 'MONTHLY' || model.freq === 'YEARLY') {
    parts.push(model.monthlyMode === 'day' ? `BYMONTHDAY=${model.monthDay}` : `BYDAY=${model.setPos}${model.posDay}`);
  }
  if (model.end.type === 'count') parts.push(`COUNT=${Math.max(1, Math.floor(model.end.count))}`);
  if (model.end.type === 'until') parts.push(`UNTIL=${model.end.date.replace(/-/g, '')}T235959Z`);
  return parts.join(';');
}

/**
 * Editor model of an RRULE, or null when the rule uses parts the editor cannot
 * show (BYHOUR, BYSETPOS lists, …) — the form then keeps the rule unchanged.
 */
export function parseRrule(rrule: string, date: string): RecurrenceModel | null {
  const map = new Map<string, string>();
  for (const part of rrule.replace(/^RRULE:/i, '').toUpperCase().split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) map.set(k, v);
  }
  const freq = map.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  const known = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'COUNT', 'UNTIL', 'WKST']);
  if ([...map.keys()].some((k) => !known.has(k))) return null;
  const model = defaultModel(date, freq);
  model.interval = Math.max(1, Number(map.get('INTERVAL') ?? '1') || 1);
  const byDay = map.get('BYDAY');
  if (freq === 'WEEKLY' && byDay) {
    const days = byDay.split(',');
    if (!days.every((d) => (WEEKDAYS as readonly string[]).includes(d))) return null;
    model.byDay = days as Weekday[];
  }
  if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const monthDay = map.get('BYMONTHDAY');
    if (byDay) {
      const m = /^([+-]?\d)(MO|TU|WE|TH|FR|SA|SU)$/.exec(byDay);
      if (!m) return null;
      model.monthlyMode = 'position';
      model.setPos = Number(m[1]);
      model.posDay = m[2] as Weekday;
    } else if (monthDay) {
      if (!/^\d{1,2}$/.test(monthDay)) return null;
      model.monthlyMode = 'day';
      model.monthDay = Number(monthDay);
    }
    if (freq === 'YEARLY' && map.get('BYMONTH')) model.month = Number(map.get('BYMONTH'));
  } else if (map.has('BYMONTHDAY') || map.has('BYMONTH') || (freq === 'DAILY' && byDay)) {
    return null;
  }
  const count = map.get('COUNT');
  const until = map.get('UNTIL');
  if (count) model.end = { type: 'count', count: Number(count) };
  else if (until && /^\d{8}/.test(until)) model.end = { type: 'until', date: `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` };
  return model;
}

const EVERY: Record<Freq, string> = { DAILY: 'Täglich', WEEKLY: 'Jede Woche', MONTHLY: 'Jeden Monat', YEARLY: 'Jedes Jahr' };
const UNITS: Record<Freq, string> = { DAILY: 'Tage', WEEKLY: 'Wochen', MONTHLY: 'Monate', YEARLY: 'Jahre' };

/** German description of a rule ("Alle 2 Wochen am Montag, Mittwoch, 10 Mal"). */
export function describeRrule(rrule: string, date: string): string {
  const preset = recurrencePresets(date).find((p) => p.rrule === rrule.replace(/^RRULE:/i, '').toUpperCase());
  if (preset) return preset.label;
  const model = parseRrule(rrule, date);
  if (!model) return 'Benutzerdefinierte Serie';
  const base = model.interval > 1 ? `Alle ${model.interval} ${UNITS[model.freq]}` : EVERY[model.freq];
  const detail = model.freq === 'WEEKLY'
    ? ` am ${model.byDay.map((d) => WEEKDAY_LABEL[d]).join(', ')}`
    : model.freq === 'MONTHLY' || model.freq === 'YEARLY'
      ? (model.monthlyMode === 'day'
          ? ` am ${model.monthDay}.${model.freq === 'YEARLY' ? ` ${MONTH_LABEL[model.month - 1]}` : ''}`
          : ` am ${ORDINAL[model.setPos] ?? `${model.setPos}.`} ${WEEKDAY_LABEL[model.posDay]}${model.freq === 'YEARLY' ? ` im ${MONTH_LABEL[model.month - 1]}` : ''}`)
      : '';
  const end = model.end.type === 'count' ? `, ${model.end.count} Mal`
    : model.end.type === 'until' ? `, bis ${model.end.date.split('-').reverse().join('.')}` : '';
  return `${base}${detail}${end}`;
}
