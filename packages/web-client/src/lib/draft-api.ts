/**
 * Server draft API (/mail/drafts) used by the compose window: autosave,
 * reopen, discard, send-from-draft (with the undo hold) and unsend.
 */
import { api, apiFetch } from '../api/client.js';
import { ApiError, apiErrorFromBody } from './errors.js';
import type { DraftAttachmentRef, SavedDraft } from './draft-autosave.js';
import { draftConflictFromBody, saveDraftWith } from './draft-conflict.js';

export interface DraftPayload {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  inReplyTo?: string;
  references?: string;
  /** 9.3: send as / on behalf of a shared mailbox (server checks the permission) */
  sendAs?: string;
  sendOnBehalfOf?: string;
  /** Attachments of the current server version to keep (by id). */
  keepAttachmentIds: string[];
  /** New local files (uploaded with this save). */
  files: File[];
}

export interface SavedDraftResponse extends SavedDraft {
  attachments: DraftAttachmentRef[];
}

export interface LoadedDraft {
  id: string;
  savedAt: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  inReplyTo: string | null;
  references: string[];
  /** 9.3: sender mode stored in the draft (From/Sender headers) */
  sendAs?: string | null;
  sendOnBehalfOf?: string | null;
  attachments: DraftAttachmentRef[];
}

async function writeDraft(method: 'POST' | 'PUT', path: string, p: DraftPayload): Promise<SavedDraftResponse> {
  const { files, ...fields } = p;
  let res: Response;
  if (files.length) {
    const form = new FormData();
    form.append('draft', JSON.stringify(fields));
    for (const f of files) form.append('attachments', f);
    res = await apiFetch(path, { method, body: form }, null);
  } else {
    res = await apiFetch(path, { method, body: JSON.stringify(fields) }, 'application/json');
  }
  const body = await res.json().catch(() => ({ error: res.statusText })) as unknown;
  if (!res.ok) {
    const err = apiErrorFromBody(body, res.status);
    throw draftConflictFromBody(body, res.status, err.message) ?? err;
  }
  return body as SavedDraftResponse;
}

export { isDraftLocked, DraftLockedError, DraftSupersededError } from './draft-conflict.js';

/**
 * Creates (id null) or replaces a draft (8.1 conflict rules, lib/draft-conflict.ts):
 * superseded → retried once on the current version (no duplicate draft);
 * being / already sent → DraftLockedError (autosave stops); 404 gone → recreated
 * so nothing typed is lost (attachments of the deleted version cannot be kept).
 */
export function saveDraft(id: string | null, p: DraftPayload): Promise<SavedDraftResponse> {
  return saveDraftWith(id, p, {
    post: (payload) => writeDraft('POST', '/mail/drafts', payload),
    put: (draftId, payload) => writeDraft('PUT', `/mail/drafts/${encodeURIComponent(draftId)}`, payload),
  });
}

export const loadDraft = (id: string) => api.get<LoadedDraft>(`/mail/drafts/${encodeURIComponent(id)}`);

export const deleteDraft = (id: string) => api.delete<{ ok: boolean }>(`/mail/drafts/${encodeURIComponent(id)}`);

/**
 * Sends a draft. 8.1: `500 SEND_STATE_UNSAVED` means the mail IS queued but its
 * state could not be stored — that is a success for the caller (never resend);
 * `stateUnsaved` lets the UI mention it.
 */
export async function sendDraft(id: string, body: { undoDelaySec?: number; scheduledAt?: string; requestReceipt?: boolean }) {
  try {
    return await api.post<{ ok: boolean; jobId: string; scheduled: boolean; sendAt?: string; stateUnsaved?: boolean }>(
      `/mail/drafts/${encodeURIComponent(id)}/send`, body);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'SEND_STATE_UNSAVED') {
      return { ok: true, jobId: '', scheduled: !!body.scheduledAt, stateUnsaved: true };
    }
    throw err;
  }
}

/** Withdraws a held/scheduled send; false when the server is already sending it. */
export async function unsendDraft(id: string): Promise<boolean> {
  try {
    await api.post(`/mail/drafts/${encodeURIComponent(id)}/unsend`, {});
    return true;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 409 || err.status === 404)) return false;
    throw err;
  }
}
