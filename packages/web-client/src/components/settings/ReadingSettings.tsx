/** 9.4: Settings → Lesen (mark as read, read receipts, Deleted Items on logout, notifications). */
import { usePreferences } from '../../store/preferences.js';
import type { MarkReadMode, NewMailNotification, ReceiptPolicy } from '../../lib/preferences.js';
import { CheckField, Group, SectionHeader, SelectField } from './controls.js';
import { TrustedSendersSettings } from './TrustedSendersSettings.js';

const MARK_READ: ReadonlyArray<{ value: MarkReadMode; label: string }> = [
  { value: 'immediately', label: 'Sofort beim Öffnen' },
  { value: 'delay', label: 'Nach einigen Sekunden im Lesebereich' },
  { value: 'manual', label: 'Nur manuell' },
];
const DELAYS = [2, 5, 10, 30, 60].map((s) => ({ value: s, label: `${s} Sekunden` }));
const REQUEST: ReadonlyArray<{ value: ReceiptPolicy; label: string }> = [
  { value: 'never', label: 'Nie anfordern' },
  { value: 'ask', label: 'Beim Verfassen auswählbar' },
  { value: 'always', label: 'Immer anfordern' },
];
const ANSWER: ReadonlyArray<{ value: ReceiptPolicy; label: string }> = [
  { value: 'never', label: 'Nie senden' },
  { value: 'ask', label: 'Jedes Mal fragen' },
  { value: 'always', label: 'Immer senden' },
];
const NOTIFY: ReadonlyArray<{ value: NewMailNotification; label: string }> = [
  { value: 'toast', label: 'Hinweis einblenden' },
  { value: 'sound', label: 'Ton abspielen' },
  { value: 'none', label: 'Keine Benachrichtigung' },
];

export function ReadingSettings() {
  const reading = usePreferences((s) => s.prefs.reading);
  const notification = usePreferences((s) => s.prefs.view.newMailNotification);
  const update = usePreferences((s) => s.update);
  const delayOptions = DELAYS.some((d) => d.value === reading.markReadDelaySec)
    ? DELAYS
    : [...DELAYS, { value: reading.markReadDelaySec, label: `${reading.markReadDelaySec} Sekunden` }];

  return (
    <section className="space-y-8">
      <SectionHeader title="Lesen" description="Wie geöffnete Nachrichten behandelt werden. Gilt auf allen Geräten." />

      <Group title="Als gelesen markieren">
        <SelectField label="Nachrichten als gelesen markieren" value={reading.markRead} options={MARK_READ}
          onChange={(markRead) => update({ reading: { markRead } })} />
        {reading.markRead === 'delay' && (
          <SelectField label="Verzögerung" value={reading.markReadDelaySec} options={delayOptions}
            onChange={(markReadDelaySec) => update({ reading: { markReadDelaySec } })} />
        )}
      </Group>

      <Group title="Lesebestätigungen">
        <SelectField label="Für gesendete Nachrichten" value={reading.requestReceipts} options={REQUEST}
          onChange={(requestReceipts) => update({ reading: { requestReceipts } })} />
        <SelectField label="Auf Anforderungen antworten" value={reading.answerReceipts} options={ANSWER}
          onChange={(answerReceipts) => update({ reading: { answerReceipts } })}
          hint="„Immer senden“ antwortet automatisch nur an die Domäne des Absenders – sonst wird gefragt. Nachrichten im Junk-Ordner werden nie bestätigt." />
      </Group>

      <TrustedSendersSettings />

      <Group title="Benachrichtigung bei neuer Nachricht">
        <SelectField label="Art der Benachrichtigung" value={notification} options={NOTIFY}
          onChange={(newMailNotification) => update({ view: { newMailNotification } })} />
      </Group>

      <Group title="Abmelden">
        <CheckField label="Gelöschte Elemente beim Abmelden leeren" checked={reading.emptyTrashOnLogout}
          onChange={(emptyTrashOnLogout) => update({ reading: { emptyTrashOnLogout } })}
          hint="Geleerte Nachrichten bleiben für die Aufbewahrungsfrist unter „Gelöschte Elemente wiederherstellen“ verfügbar." />
      </Group>
    </section>
  );
}
