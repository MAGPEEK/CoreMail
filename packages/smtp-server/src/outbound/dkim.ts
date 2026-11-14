/**
 * Central DKIM key resolution for the outbound worker.
 *
 * Producers of `smtp-outbound` jobs (api-gateway, JMAP, SMTP submission on
 * 465/587, rule forwards, ActiveSync) do not all attach DKIM fields.
 * The worker therefore resolves the key from the envelope-from domain when a
 * job carries none, so every outgoing mail from a local domain is signed.
 */
import { prisma } from '@coremail/storage/prisma';

export interface DkimFields {
  dkimDomain?:     string;
  dkimSelector?:   string;
  dkimPrivateKey?: string;
}

export interface DomainDkimRow {
  name:           string;
  dkimSelector:   string;
  dkimPrivateKey: string;
}

/** Lower-cased domain part of an address, '' for `<>`/malformed addresses. */
export function senderDomain(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0) return '';
  return address.slice(at + 1).trim().replace(/>$/, '').toLowerCase();
}

/** True when the job already carries a complete DKIM triple. */
export function hasCompleteDkim(job: DkimFields): boolean {
  return !!(job.dkimDomain && job.dkimSelector && job.dkimPrivateKey);
}

/**
 * Pure decision: keep the job's own DKIM fields if complete, otherwise use
 * the domain row (when it has a usable key), otherwise sign nothing.
 */
export function pickDkim(job: DkimFields, domain: DomainDkimRow | null): DkimFields {
  if (hasCompleteDkim(job)) {
    return { dkimDomain: job.dkimDomain!, dkimSelector: job.dkimSelector!, dkimPrivateKey: job.dkimPrivateKey! };
  }
  if (domain && domain.dkimPrivateKey.trim() !== '' && domain.dkimSelector) {
    return { dkimDomain: domain.name, dkimSelector: domain.dkimSelector, dkimPrivateKey: domain.dkimPrivateKey };
  }
  return {};
}

/** Resolve the DKIM fields for an outbound job (DB lookup only when needed). */
export async function resolveJobDkim(job: DkimFields & { from: string }): Promise<DkimFields> {
  if (hasCompleteDkim(job)) return pickDkim(job, null);
  const name = senderDomain(job.from);
  if (!name) return {};
  const domain = await prisma.domain.findUnique({
    where:  { name },
    select: { name: true, dkimSelector: true, dkimPrivateKey: true },
  });
  return pickDkim(job, domain);
}
