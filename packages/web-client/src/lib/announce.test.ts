import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announce, subscribeAnnouncements, selectionAnnouncement, type Announcement } from './announce.ts';

test('announce delivers trimmed text and a rising sequence number', () => {
  const got: Announcement[] = [];
  const off = subscribeAnnouncements((a) => got.push(a));
  announce('  Ordner geöffnet ');
  announce('Ordner geöffnet');
  off();
  announce('nach dem Abmelden');
  assert.equal(got.length, 2);
  assert.equal(got[0]!.text, 'Ordner geöffnet');
  assert.ok(got[1]!.seq > got[0]!.seq);
});

test('announce ignores empty text', () => {
  const got: Announcement[] = [];
  const off = subscribeAnnouncements((a) => got.push(a));
  announce('   ');
  off();
  assert.equal(got.length, 0);
});

test('selectionAnnouncement covers none, one and many', () => {
  assert.equal(selectionAnnouncement(0), 'Auswahl aufgehoben');
  assert.equal(selectionAnnouncement(1, 'Angebot'), 'Ausgewählt: Angebot');
  assert.equal(selectionAnnouncement(1), '1 Nachricht ausgewählt');
  assert.equal(selectionAnnouncement(4), '4 Nachrichten ausgewählt');
});
