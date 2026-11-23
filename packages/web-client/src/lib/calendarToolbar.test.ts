import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CALENDAR_TOOLBAR, SLOT_MINUTES, groupToolbar, parseAction, resolveToolbar, type ToolbarState,
} from './calendarToolbar.ts';

const base: ToolbarState = {
  view: 'dayGridMonth', activeFilters: 0, hasOwnCalendar: true, slotMinutes: 30, agendaOpen: false, compact: false,
};
const cmd = (s: ToolbarState, id: string) => resolveToolbar(s).find((c) => c.id === id);

test('the toolbar row: views, time scale, filter, day agenda, share, print, "…" with the calendar settings', () => {
  assert.deepEqual(resolveToolbar(base).map((c) => c.label),
    ['Tag', 'Arbeitswoche', 'Woche', 'Monat', 'Zeitskala', 'Filter', 'Tagesagenda', 'Freigeben', 'Drucken', 'Kalender-Einstellungen']);
  assert.equal(cmd(base, 'calendar-settings')!.placement, 'overflow');
});

test('"Neuer Termin" sits in the calendar list card; on phones it joins the toolbar (pinned)', () => {
  assert.equal(cmd(base, 'new'), undefined);
  const c = cmd({ ...base, compact: true }, 'new')!;
  assert.equal(c.action, 'new-event');
  assert.equal(c.placement, 'pinned');
  assert.equal(c.options, undefined, 'a plain button, no menu');
});

test('the pressed view command follows the page view', () => {
  for (const view of ['timeGridDay', 'workWeek', 'timeGridWeek', 'dayGridMonth'] as const) {
    const pressed = resolveToolbar({ ...base, view }).filter((c) => c.pressed && c.id.startsWith('view-'));
    assert.deepEqual(pressed.map((c) => c.action), [`view:${view}`]);
  }
});

test('filter label and pressed state reflect active filters', () => {
  assert.equal(cmd(base, 'filter')!.label, 'Filter');
  assert.equal(cmd(base, 'filter')!.pressed, false);
  const on = cmd({ ...base, activeFilters: 2 }, 'filter')!;
  assert.equal(on.label, 'Filter angewendet');
  assert.equal(on.pressed, true);
});

test('sharing needs an own calendar', () => {
  assert.equal(cmd(base, 'share')!.enabled, true);
  assert.equal(cmd({ ...base, hasOwnCalendar: false }, 'share')!.enabled, false);
});

test('time scale lists the existing slot values and is off in the month view', () => {
  const month = cmd(base, 'time-scale')!;
  assert.equal(month.enabled, false);
  assert.equal(month.action, null);
  assert.deepEqual(month.options!.map((o) => o.action), SLOT_MINUTES.map((m) => `slot:${m}`));
  const week = cmd({ ...base, view: 'timeGridWeek' }, 'time-scale')!;
  assert.equal(week.enabled, true);
  assert.deepEqual(week.options!.filter((o) => o.label.includes('aktuell')).map((o) => o.action), ['slot:30']);
});

test('groups keep their order and every command appears once', () => {
  const groups = groupToolbar(resolveToolbar({ ...base, compact: true }));
  assert.deepEqual(groups.map((g) => g.group), ['new', 'view', 'scale', 'tools', 'more']);
  const ids = groups.flatMap((g) => g.commands.map((c) => c.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, CALENDAR_TOOLBAR.length);
});

test('parseAction separates parameterised actions', () => {
  assert.deepEqual(parseAction('view:workWeek'), { kind: 'view', view: 'workWeek' });
  assert.deepEqual(parseAction('slot:15'), { kind: 'slot', minutes: 15 });
  assert.deepEqual(parseAction('print'), { kind: 'plain', action: 'print' });
});

test('every action of the toolbar is one the page dispatches', () => {
  const known = new Set(['new-event', 'today', 'filter', 'share', 'print', 'agenda', 'settings']);
  for (const c of resolveToolbar({ ...base, compact: true })) {
    for (const a of [c.action, ...(c.options ?? []).map((o) => o.action)]) {
      if (a === null) continue;
      const p = parseAction(a);
      assert.ok(p.kind !== 'plain' || known.has(p.action), `${c.id}: ${a}`);
    }
  }
});

test('the calendar ribbon is gone', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(existsSync(join(src, 'lib/calendarRibbon.ts')), false);
});
