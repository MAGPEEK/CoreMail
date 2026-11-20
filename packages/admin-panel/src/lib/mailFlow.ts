/**
 * 9.4 per-mailbox mail flow (BCP mailbox edit): API view ↔ form state and the
 * PUT body. Sender lists are edited as text (one entry per line; commas and
 * semicolons separate as well); limits as whole MB / recipient numbers, empty =
 * the global limit. Pure, unit-tested.
 */
export type MailFlowKind = 'user' | 'shared';

export interface MailFlowView {
  hiddenFromGal: boolean;
  forwardTo: string | null;
  forwardKeepCopy: boolean;
  acceptFrom: string[];
  rejectFrom: string[];
  maxReceiveSizeMb: number | null;
  /** User mailboxes only. */
  maxSendSizeMb?: number | null;
  maxRecipients?: number | null;
  /** 10.5: hourly send rate (user mailboxes only). */
  maxMessagesPerHour?: number | null;
  maxRecipientsPerHour?: number | null;
}

export interface MailFlowForm {
  hiddenFromGal: boolean;
  forwardTo: string;
  forwardKeepCopy: boolean;
  acceptFrom: string;
  rejectFrom: string;
  maxReceiveSizeMb: string;
  maxSendSizeMb: string;
  maxRecipients: string;
  maxMessagesPerHour: string;
  maxRecipientsPerHour: string;
}

export type MailFlowField = 'forwardTo' | 'maxReceiveSizeMb' | 'maxSendSizeMb' | 'maxRecipients' | 'maxMessagesPerHour' | 'maxRecipientsPerHour';

const num = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(v));

/** True when the form differs from the values the server returned. */
export function formChanged(view: MailFlowView, form: MailFlowForm): boolean {
  const saved = formFromView(view);
  return (Object.keys(saved) as Array<keyof MailFlowForm>).some((k) => saved[k] !== form[k]);
}

export function formFromView(v: MailFlowView): MailFlowForm {
  return {
    hiddenFromGal: v.hiddenFromGal,
    forwardTo: v.forwardTo ?? '',
    forwardKeepCopy: v.forwardKeepCopy,
    acceptFrom: v.acceptFrom.join('\n'),
    rejectFrom: v.rejectFrom.join('\n'),
    maxReceiveSizeMb: num(v.maxReceiveSizeMb),
    maxSendSizeMb: num(v.maxSendSizeMb),
    maxRecipients: num(v.maxRecipients),
    maxMessagesPerHour: num(v.maxMessagesPerHour),
    maxRecipientsPerHour: num(v.maxRecipientsPerHour),
  };
}

/** Sender list from the text area (lines, commas, semicolons; blanks dropped). */
export function listFromText(text: string): string[] {
  return text.split(/[\n,;]+/).map((e) => e.trim()).filter(Boolean);
}

/** A limit input: '' = global (null), a positive whole number, otherwise undefined (invalid). */
export function limitFromInput(s: string): number | null | undefined {
  const v = s.trim();
  if (v === '') return null;
  return /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : undefined;
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The PUT body of the form, or the first invalid field. */
export function patchFromForm(form: MailFlowForm, kind: MailFlowKind):
  { ok: true; patch: Record<string, unknown> } | { ok: false; field: MailFlowField } {
  const forwardTo = form.forwardTo.trim();
  if (forwardTo && !ADDRESS.test(forwardTo)) return { ok: false, field: 'forwardTo' };
  const limits: Array<[MailFlowField, string]> = kind === 'user'
    ? [['maxReceiveSizeMb', form.maxReceiveSizeMb], ['maxSendSizeMb', form.maxSendSizeMb], ['maxRecipients', form.maxRecipients],
      ['maxMessagesPerHour', form.maxMessagesPerHour], ['maxRecipientsPerHour', form.maxRecipientsPerHour]]
    : [['maxReceiveSizeMb', form.maxReceiveSizeMb]];
  const patch: Record<string, unknown> = {
    hiddenFromGal: form.hiddenFromGal,
    forwardTo: forwardTo || null,
    forwardKeepCopy: form.forwardKeepCopy,
    acceptFrom: listFromText(form.acceptFrom),
    rejectFrom: listFromText(form.rejectFrom),
  };
  for (const [field, value] of limits) {
    const n = limitFromInput(value);
    if (n === undefined) return { ok: false, field };
    patch[field] = n;
  }
  return { ok: true, patch };
}
