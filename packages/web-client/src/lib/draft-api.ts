/**
 * Server draft API (/mail/drafts) used by the compose window: autosave,
 * reopen, discard, send-from-draft (with the undo hold) and unsend.
 */
import { api, apiFetch } from '../api/client.js';
import { ApiError, apiErrorFromBody } from './errors.js';
import type { DraftAttachmentRef, SavedDraft } from './draft-autosave.js';

export interface DraftPayload {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  inReplyTo?: string;
  references?: string;
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
  if (!res.ok) throw apiErrorFromBody(body, res.status);
  return body as SavedDraftResponse;
}

/**
 * Creates (id null) or replaces a draft. A draft deleted meanwhile (another
 * client, sent elsewhere) is recreated so nothing typed is lost; attachments
 * that only existed on the deleted version cannot be kept then.
 */
export async function saveDraft(id: string | null, p: DraftPayload): Promise<SavedDraftResponse> {
  if (!id) return writeDraft('POST', '/mail/drafts', p);
  try {
    return await writeDraft('PUT', `/mail/drafts/${encodeURIComponent(id)}`, p);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return writeDraft('POST', '/mail/drafts', { ...p, keepAttachmentIds: [] });
    }
    throw err;
  }
}

export const loadDraft = (id: string) => api.get<LoadedDraft>(`/mail/drafts/${encodeURIComponent(id)}`);

export const deleteDraft = (id: string) => api.delete<{ ok: boolean }>(`/mail/drafts/${encodeURIComponent(id)}`);

export const sendDraft = (id: string, body: { undoDelaySec?: number; scheduledAt?: string }) =>
  api.post<{ ok: boolean; jobId: string; scheduled: boolean; sendAt?: string }>(`/mail/drafts/${encodeURIComponent(id)}/send`, body);

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
