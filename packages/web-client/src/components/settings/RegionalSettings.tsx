/** 9.4: Settings → Region (time zone, date and time format). The language stays in Settings → Sprache. */
import { useMemo } from 'react';
import { usePreferences } from '../../store/preferences.js';
import type { DateFormat, TimeFormat } from '../../lib/preferences.js';
import { formatDate, formatTime, timeZoneOptions } from '../../lib/regionalFormat.js';
import { Group, SectionHeader, SelectField } from './controls.js';

const DATE_FORMATS: DateFormat[] = ['dd.MM.yyyy', 'yyyy-MM-dd', 'MM/dd/yyyy', 'd. MMM yyyy'];
const TIME_FORMATS: TimeFormat[] = ['24h', '12h'];

export function RegionalSettings() {
  const regional = usePreferences((s) => s.prefs.regional);
  const update = usePreferences((s) => s.update);
  const zones = useMemo(() => [
    { value: '', label: 'Wie im Browser' },
    ...timeZoneOptions(regional.timeZone).map((z) => ({ value: z, label: z.replace(/_/g, ' ') })),
  ], [regional.timeZone]);
  const sample = useMemo(() => new Date(), []);

  return (
    <section className="space-y-8">
      <SectionHeader title="Region" description="Zeitzone und Darstellung von Datum und Uhrzeit in der Nachrichtenliste, im Lesebereich und in Einladungen." />
      <Group title="Zeit und Datum">
        <SelectField label="Zeitzone" value={regional.timeZone} options={zones}
          onChange={(timeZone) => update({ regional: { timeZone } })}
          hint="Auch für die Zeitangaben in Termineinladungen, die Sie versenden." />
        <SelectField label="Datumsformat" value={regional.dateFormat}
          options={DATE_FORMATS.map((f) => ({ value: f, label: formatDate(sample, { ...regional, dateFormat: f }) }))}
          onChange={(dateFormat) => update({ regional: { dateFormat } })} />
        <SelectField label="Uhrzeitformat" value={regional.timeFormat}
          options={TIME_FORMATS.map((f) => ({ value: f, label: `${f === '24h' ? '24 Stunden' : '12 Stunden'} (${formatTime(sample, { ...regional, timeFormat: f })})` }))}
          onChange={(timeFormat) => update({ regional: { timeFormat } })} />
      </Group>
    </section>
  );
}
