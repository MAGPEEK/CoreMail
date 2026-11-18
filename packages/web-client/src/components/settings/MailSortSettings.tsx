/** 9.4: Settings → Ansicht — sort order of message lists and order inside conversations. */
import { usePreferences } from '../../store/preferences.js';
import type { ConversationOrder, SortDir, SortField } from '../../lib/preferences.js';
import { Group, SelectField } from './controls.js';

const FIELDS: ReadonlyArray<{ value: SortField; label: string }> = [
  { value: 'date', label: 'Datum' }, { value: 'from', label: 'Absender' },
  { value: 'subject', label: 'Betreff' }, { value: 'size', label: 'Größe' },
];
const DIRS: ReadonlyArray<{ value: SortDir; label: string }> = [
  { value: 'desc', label: 'Absteigend (neueste / größte / Z zuerst)' },
  { value: 'asc', label: 'Aufsteigend (älteste / kleinste / A zuerst)' },
];
const CONVERSATION: ReadonlyArray<{ value: ConversationOrder; label: string }> = [
  { value: 'newestFirst', label: 'Neueste Nachricht oben' },
  { value: 'oldestFirst', label: 'Älteste Nachricht oben' },
];

export function MailSortSettings() {
  const view = usePreferences((s) => s.prefs.view);
  const update = usePreferences((s) => s.update);
  return (
    <Group title="Sortierung">
      <div className="grid grid-cols-2 gap-3">
        <SelectField label="Sortieren nach" value={view.sortBy} options={FIELDS} onChange={(sortBy) => update({ view: { sortBy } })} />
        <SelectField label="Reihenfolge" value={view.sortDir} options={DIRS} onChange={(sortDir) => update({ view: { sortDir } })} />
      </div>
      <SelectField label="Innerhalb einer Konversation" value={view.conversationOrder} options={CONVERSATION}
        onChange={(conversationOrder) => update({ view: { conversationOrder } })}
        hint="Wirkt, wenn Nachrichten nach Konversation gruppiert werden." />
    </Group>
  );
}
