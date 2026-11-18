/** 9.4: Settings → Verfassen (format, default font, forgotten-attachment check). */
import { usePreferences } from '../../store/preferences.js';
import type { ComposeFormat } from '../../lib/preferences.js';
import { CheckField, Group, SectionHeader, SelectField } from './controls.js';

const FORMATS: ReadonlyArray<{ value: ComposeFormat; label: string }> = [
  { value: 'html', label: 'HTML (mit Formatierung)' },
  { value: 'plain', label: 'Nur Text' },
];
const FONTS = ['', 'Arial', 'Calibri', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS']
  .map((f) => ({ value: f, label: f || 'Standard' }));
const SIZES = ['', '10px', '12px', '14px', '16px', '18px'].map((s) => ({ value: s, label: s ? s.replace('px', ' px') : 'Standard' }));

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
        <SelectField label="Schriftgröße" value={compose.fontSize} options={SIZES}
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
