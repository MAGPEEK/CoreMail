import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALENDAR_RIBBON, SLOT_MINUTES, flattenRibbon, parseAction, resolveRibbon, type RibbonState,
} from './calendarRibbon.ts';

const base: RibbonState = {
  view: 'dayGridMonth', activeFilters: 0, hasOwnCalendar: true, slotMinutes: 30, aboutAvailable: false, agendaOpen: false,
};
const tab = (s: RibbonState, id: string) => resolveRibbon(s).find((t) => t.id === id)!;
const cmd = (s: RibbonState, tabId: string, id: string) => tab(s, tabId).commands.find((c) => c.id === id);

test('tabs are Start, Ansicht, Hilfe with German labels', () => {
  assert.deepEqual(CALENDAR_RIBBON.map((t) => t.label), ['Start', 'Ansicht', 'Hilfe']);
});

test('Start offers the new-event split with Ereignis and E-Mail', () => {
  const c = cmd(base, 'start', 'new')!;
  assert.equal(c.action, 'new-event');
  assert.deepEqual(c.options!.map((o) => [o.label, o.action]), [['Ereignis', 'new-event'], ['E-Mail', 'new-mail']]);
});

test('the pressed view command follows the page view', () => {
  for (const view of ['timeGridDay', 'workWeek', 'timeGridWeek', 'dayGridMonth'] as const) {
    const pressed = tab({ ...base, view }, 'start').commands.filter((c) => c.pressed && c.id.startsWith('view-'));
    assert.deepEqual(pressed.map((c) => c.action), [`view:${view}`]);
  }
});

test('filter label and pressed state reflect active filters', () => {
  assert.equal(cmd(base, 'start', 'filter')!.label, 'Filter');
  assert.equal(cmd(base, 'start', 'filter')!.pressed, false);
  const on = cmd({ ...base, activeFilters: 2 }, 'start', 'filter')!;
  assert.equal(on.label, 'Filter angewendet');
  assert.equal(on.pressed, true);
});

test('sharing needs an own calendar', () => {
  assert.equal(cmd(base, 'start', 'share')!.enabled, true);
  assert.equal(cmd({ ...base, hasOwnCalendar: false }, 'start', 'share')!.enabled, false);
});

test('time scale lists the existing slot values and is off in the month view', () => {
  const month = cmd(base, 'view', 'time-scale')!;
  assert.equal(month.enabled, false);
  assert.equal(month.action, null);
  assert.deepEqual(month.options!.map((o) => o.action), SLOT_MINUTES.map((m) => `slot:${m}`));
  const week = cmd({ ...base, view: 'timeGridWeek' }, 'view', 'time-scale')!;
  assert.equal(week.enabled, true);
  assert.deepEqual(week.options!.filter((o) => o.label.includes('aktuell')).map((o) => o.action), ['slot:30']);
});

test('"Über CoreMail" is hidden until an about dialog exists', () => {
  assert.equal(cmd(base, 'help', 'about'), undefined);
  assert.equal(cmd({ ...base, aboutAvailable: true }, 'help', 'about')!.enabled, true);
  assert.deepEqual(tab(base, 'help').commands.map((c) => c.action), ['shortcuts']);
});

test('flattenRibbon lists every command once, view buttons only in "Anordnen"', () => {
  const groups = flattenRibbon(resolveRibbon({ ...base, aboutAvailable: true }));
  const ids = groups.flatMap((g) => g.commands.map((c) => c.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(groups.map((g) => g.group), ['Neu', 'Gehe zu', 'Anordnen', 'Filter', 'Teilen', 'Zeitraster', 'Einstellungen', 'Hilfe']);
  assert.equal(groups.find((g) => g.group === 'Anordnen')!.commands.length, 5);
});

test('parseAction separates parameterised actions', () => {
  assert.deepEqual(parseAction('view:workWeek'), { kind: 'view', view: 'workWeek' });
  assert.deepEqual(parseAction('slot:15'), { kind: 'slot', minutes: 15 });
  assert.deepEqual(parseAction('print'), { kind: 'plain', action: 'print' });
});

test('every action of the ribbon is one the page dispatches', () => {
  const known = new Set(['new-event', 'new-mail', 'today', 'filter', 'share', 'print', 'agenda', 'settings', 'shortcuts', 'about']);
  for (const t of resolveRibbon({ ...base, aboutAvailable: true })) {
    for (const c of t.commands) {
      for (const a of [c.action, ...(c.options ?? []).map((o) => o.action)]) {
        if (a === null) continue;
        const p = parseAction(a);
        assert.ok(p.kind !== 'plain' || known.has(p.action), `${c.id}: ${a}`);
      }
    }
  }
});
