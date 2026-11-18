/** 9.4: Settings → Verfassen (format, default font, forgotten-attachment check). */
import { usePreferences } from '../../store/preferences.js';
import type { ComposeFormat } from '../../lib/preferences.js';
import { CheckField, Group, SectionHeader, SelectField } from './controls.js';
import { COMPOSE_FONTS, COMPOSE_FONT_SIZES_PT, DEFAULT_FONT_LABEL, DEFAULT_FONT_SIZE, sizeLabel, sizeValue } from '../../lib/composeFonts.js';

const FORMATS: ReadonlyArray<{ value: ComposeFormat; label: string }> = [
  { value: 'html', label: 'HTML (mit Formatierung)' },
  { value: 'plain', label: 'Nur Text' },
];
// 9.4: same fonts and sizes as the compose ribbon (lib/composeFonts.ts); "Standard" = Calibri 11 pt
const FONTS = [{ value: '', label: `Standard (${DEFAULT_FONT_LABEL})` }, ...COMPOSE_FONTS.map((f) => ({ value: f.label, label: f.label }))];
const SIZE_OPTIONS = [{ value: '', label: `Standard (${sizeLabel(DEFAULT_FONT_SIZE)})` }, ...COMPOSE_FONT_SIZES_PT.map(sizeValue).map((s) => ({ value: s, label: sizeLabel(s) }))];
/** A size stored before 9.4 (px) stays selectable. */
const sizesWith = (current: string) => (SIZE_OPTIONS.some((o) => o.value === current) ? SIZE_OPTIONS : [...SIZE_OPTIONS, { value: current, label: sizeLabel(current) }]);

export function ComposeSettings() {
  const compose = usePreferences((s) => s.prefs.compose);
  const update = usePreferences((s) => s.update);
  return (
    <section className="space-y-8">
      <SectionHeader title="Verfassen" description="Standardwerte für neue Nachrichten, Antworten und Weiterleitungen." />
      <Group title="Format">
        <SelectField label="Nachrichtenformat" value={compose.format} options={FORMATS}
          onChange={(format) => update({ compose: { format } })}
          hint="„Nur Text“ sendet die Nachricht ohne Formatierung, Bilder und Schriftarten." />
        <SelectField label="Schriftart" value={compose.fontFamily} options={FONTS}
          onChange={(fontFamily) => update({ compose: { fontFamily } })} />
        <SelectField label="Schriftgröße" value={compose.fontSize} options={sizesWith(compose.fontSize)}
          onChange={(fontSize) => update({ compose: { fontSize } })} />
      </Group>
      <Group title="Prüfungen vor dem Senden">
        <CheckField label="An vergessene Anhänge erinnern" checked={compose.attachmentReminder}
          onChange={(attachmentReminder) => update({ compose: { attachmentReminder } })}
          hint="Fragt nach, wenn Betreff oder Text einen Anhang erwähnen (z. B. „Anhang“, „anbei“, „attached“), aber keine Datei angehängt ist." />
      </Group>
    </section>
  );
}
