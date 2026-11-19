import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultFolderOf, paneRootFolders, ROOT_KEY } from './folderTree.ts';

interface F { id: string; name: string; displayName?: string; noSelect?: boolean }

test('default folder: INBOX, else the first selectable folder', () => {
  assert.equal(defaultFolderOf([f('s', 'Sent'), f('i', 'INBOX')])?.id, 'i');
  assert.equal(defaultFolderOf([{ ...f('i', 'INBOX'), noSelect: true }, f('p', 'Projekte')])?.id, 'p');
  assert.equal(defaultFolderOf([{ ...f('i', 'INBOX'), noSelect: true }]), undefined);
  assert.equal(defaultFolderOf([]), undefined);
});
const f = (id: string, name: string): F => ({ id, name });

test('full mailbox: only the system folders are roots', () => {
  const inbox = f('i', 'INBOX'), sent = f('s', 'Sent'), proj = f('p', 'Projekte'), sub = f('q', 'Sub');
  const all = [inbox, sent, proj, sub];
  const children = new Map<string, F[]>([[ROOT_KEY, [inbox, sent]], ['i', [proj]], ['p', [sub]]]);
  assert.deepEqual(paneRootFolders([inbox, sent], children, all), [inbox, sent]);
});

test('folder-scoped mailbox: folders whose parent is missing become roots', () => {
  const b = f('b', 'Berichte'), a = f('a', 'Angebote'), child = f('c', 'Q1');
  const all = [b, a, child];
  // no INBOX: custom root folders sit at ROOT_KEY; "a" hangs under a parent that is not listed
  const children = new Map<string, F[]>([[ROOT_KEY, [b]], ['hidden-parent', [a]], ['b', [child]]]);
  assert.deepEqual(paneRootFolders([], children, all).map((x) => x.id), ['a', 'b']);
});

test('system roots first, no duplicates', () => {
  const inbox = f('i', 'INBOX'), x = f('x', 'Extern');
  const children = new Map<string, F[]>([[ROOT_KEY, [inbox]], ['gone', [x]]]);
  assert.deepEqual(paneRootFolders([inbox], children, [inbox, x]).map((v) => v.id), ['i', 'x']);
});
