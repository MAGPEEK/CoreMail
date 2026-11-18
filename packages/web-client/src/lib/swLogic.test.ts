/**
 * 9.4 service worker logic (public/sw-logic.js — a classic script without a
 * build step), loaded into a sandbox like importScripts() does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SW_OPEN_MESSAGE_TYPE } from './webPush.ts';

interface SwLogic {
  OPEN_MESSAGE_TYPE: string;
  notificationFromPush(text: string): { title: string; options: { body: string; icon: string; tag?: string; data: { url: string } } };
  clickTarget(data: unknown): string;
  pickClient<T extends { type: string; focused?: boolean; visibilityState?: string }>(clients: T[]): T | null;
}

function load(): SwLogic {
  const self: Record<string, unknown> = {};
  vm.runInNewContext(readFileSync(new URL('../../public/sw-logic.js', import.meta.url), 'utf8'), { self });
  return self['CoreMailSw'] as SwLogic;
}

const sw = load();

test('the worker and the app agree on the open message type', () => {
  assert.equal(sw.OPEN_MESSAGE_TYPE, SW_OPEN_MESSAGE_TYPE);
});

test('notificationFromPush: gateway payload → title, body, tag, click URL', () => {
  const n = sw.notificationFromPush(JSON.stringify({ title: 'Ann', body: 'Budget', tag: 'mail-m1', url: '/mail?folder=f&message=m' }));
  assert.equal(n.title, 'Ann');
  assert.equal(n.options.body, 'Budget');
  assert.equal(n.options.tag, 'mail-m1');
  assert.equal(n.options.icon, '/favicon.svg');
  assert.equal(n.options.data.url, '/mail?folder=f&message=m');
});

test('notificationFromPush: garbage or foreign URLs never leave the webmail', () => {
  assert.equal(sw.notificationFromPush('not json').title, 'Neue Nachricht');
  assert.equal(sw.notificationFromPush('[1]').options.data.url, '/mail');
  assert.equal(sw.notificationFromPush(JSON.stringify({ url: 'https://evil.example/' })).options.data.url, '/mail');
  assert.equal(sw.notificationFromPush(JSON.stringify({ url: '//evil.example/x' })).options.data.url, '/mail');
  assert.equal(sw.notificationFromPush(JSON.stringify({ url: '/\\evil.example' })).options.data.url, '/mail');
  assert.equal(sw.notificationFromPush(JSON.stringify({ icon: 'https://evil.example/i.png' })).options.icon, '/favicon.svg');
  assert.equal(sw.notificationFromPush(JSON.stringify({ title: 'x' })).options.tag, undefined);
});

test('clickTarget + pickClient: focused window first, then a visible one, else the first', () => {
  assert.equal(sw.clickTarget({ url: '/mail?folder=f&message=m' }), '/mail?folder=f&message=m');
  assert.equal(sw.clickTarget(null), '/mail');
  const a = { type: 'window', id: 'a', visibilityState: 'hidden' };
  const b = { type: 'window', id: 'b', visibilityState: 'visible' };
  const c = { type: 'window', id: 'c', focused: true };
  const w = { type: 'worker', id: 'w', focused: true };
  assert.equal(sw.pickClient([a, b, c, w]), c);
  assert.equal(sw.pickClient([a, b, w]), b);
  assert.equal(sw.pickClient([a]), a);
  assert.equal(sw.pickClient([w]), null);
  assert.equal(sw.pickClient([]), null);
});
