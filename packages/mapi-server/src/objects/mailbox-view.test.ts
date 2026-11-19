/** The MAPI folder tree (objects/mailbox-view.ts): role folders and their display names. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MailboxView, ROLE_DISPLAY_NAME } from './mailbox-view.js';
import type { FolderRecord } from '../store/types.js';

function folder(id: string, name: string, displayName: string, parentId: string | null = null): FolderRecord {
  return { id, name, displayName, parentId, totalCount: 0, unreadCount: 0, createdAt: new Date(0), clientId: null };
}

/** How differently provisioned mailboxes store the default folders' display names. */
const PROVISIONED: Record<string, Array<[string, string]>> = {
  adminApi: [['INBOX', 'Inbox'], ['Drafts', 'Drafts'], ['Sent', 'Sent Items'], ['Trash', 'Deleted Items'], ['Junk', 'Junk Email'], ['Archive', 'Archive']],
  setupWizard: [['INBOX', 'Posteingang'], ['Drafts', 'Entwürfe'], ['Sent', 'Gesendet'], ['Trash', 'Gelöscht'], ['Junk', 'Junk-E-Mail'], ['Archive', 'Archiv']],
  imapNames: [['INBOX', 'INBOX'], ['Drafts', 'Drafts'], ['Sent', 'Sent'], ['Trash', 'Trash'], ['Junk', 'Junk'], ['Archive', '']],
};

test('role folders always carry the Outlook display names, however the mailbox was provisioned', () => {
  for (const [how, rows] of Object.entries(PROVISIONED)) {
    const view = new MailboxView(rows.map(([name, displayName], i) => folder(`f${i}`, name, displayName)));
    for (const [role, name] of Object.entries(ROLE_DISPLAY_NAME)) {
      assert.equal(view.role(role as keyof typeof ROLE_DISPLAY_NAME)?.displayName, name, `${how}: ${role}`);
    }
  }
});

test('other folders keep their own display name; a nested "Sent" is no role folder', () => {
  const view = new MailboxView([
    folder('in', 'INBOX', 'Posteingang'),
    folder('p', 'Projekte', 'Projekte'),
    folder('ps', 'Projekte.Sent', 'Sent', 'p'),
    folder('n', 'Notes', ''),
  ]);
  assert.equal(view.ofRecord('p')?.displayName, 'Projekte');
  assert.equal(view.ofRecord('ps')?.displayName, 'Sent');
  assert.equal(view.ofRecord('ps')?.role, null);
  assert.equal(view.ofRecord('n')?.displayName, 'Notes', 'empty display name → folder name');
  assert.equal(view.role('sent'), undefined);
});
