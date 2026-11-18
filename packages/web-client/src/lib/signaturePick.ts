/**
 * 9.4: which named signature a new compose window starts with — per identity
 * (own address, or a shared mailbox the user sends as / on behalf of) and per
 * kind (new mail vs. reply/forward), from GET /user/signatures. No imports —
 * unit-tested with `node --test`.
 */
export interface NamedSignature { id: string; name: string; html: string }
export interface SignatureDefaults { newId: string | null; replyId: string | null }

/** Identity key of the signature defaults: 'own' or 'shared:<SharedMailbox id>'. */
export function signatureIdentity(mailbox: { kind: string; id?: string }, sendsAsMailbox: boolean): string {
  return mailbox.kind === 'shared' && sendsAsMailbox && mailbox.id ? `shared:${mailbox.id}` : 'own';
}

/** HTML of the default signature, or '' when none is set (or it was deleted). */
export function defaultSignatureHtml(
  signatures: readonly NamedSignature[],
  defaults: Readonly<Record<string, SignatureDefaults>>,
  identity: string,
  reply: boolean,
): string {
  const d = defaults[identity];
  const id = reply ? d?.replyId : d?.newId;
  return (id && signatures.find((s) => s.id === id)?.html) || '';
}
