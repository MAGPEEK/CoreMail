import nodemailer from 'nodemailer';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import { promises as dns } from 'dns';
import { createLogger } from '@coremail/core';

const log = createLogger('smtp:relay');

export interface DkimOptions {
  dkimDomain?: string;
  dkimSelector?: string;
  dkimPrivateKey?: string;
}

export async function relayMessage(
  rawBuffer: Buffer,
  from: string,
  to: string[],
  dkim: DkimOptions,
): Promise<void> {
  // DKIM-sign the message if key is available
  let signedBuffer = rawBuffer;
  if (dkim.dkimDomain && dkim.dkimSelector && dkim.dkimPrivateKey) {
    try {
      signedBuffer = await signMessage(rawBuffer, dkim);
    } catch (err) {
      log.warn({ err }, 'DKIM signing failed — sending unsigned');
    }
  }

  // Group recipients by their MX domain
  const byDomain = groupByDomain(to);

  for (const [domain, recipients] of byDomain) {
    await deliverToDomain(signedBuffer, from, recipients, domain);
  }
}

async function signMessage(rawBuffer: Buffer, dkim: DkimOptions): Promise<Buffer> {
  const signed = await dkimSign(rawBuffer, {
    canonicalization: 'relaxed/relaxed',
    algorithm: 'rsa-sha256',
    signingDomain: dkim.dkimDomain!,
    selector: dkim.dkimSelector!,
    privateKey: dkim.dkimPrivateKey!,
  });

  // dkimSign returns the DKIM-Signature header — prepend to original message
  return Buffer.concat([Buffer.from(signed.signatures), rawBuffer]);
}

async function deliverToDomain(
  rawBuffer: Buffer,
  from: string,
  recipients: string[],
  domain: string,
): Promise<void> {
  const mxRecords = await resolveMx(domain);
  if (mxRecords.length === 0) {
    throw new Error(`No MX records found for ${domain}`);
  }

  // Try MX hosts in priority order
  let lastError: Error | null = null;
  for (const mx of mxRecords) {
    try {
      const transporter = nodemailer.createTransport({
        host: mx.exchange,
        port: 25,
        secure: false,
        requireTLS: false,
        opportunisticTLS: true,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 30_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
      });

      await transporter.sendMail({
        envelope: { from, to: recipients },
        raw: rawBuffer,
      });

      log.info({ domain, mx: mx.exchange, to: recipients }, 'Delivered via MX');
      return;
    } catch (err) {
      lastError = err as Error;
      log.warn({ domain, mx: mx.exchange, err }, 'MX delivery failed, trying next');
    }
  }

  throw lastError ?? new Error(`Delivery failed to ${domain}`);
}

async function resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]> {
  try {
    const records = await dns.resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority);
  } catch {
    return [];
  }
}

function groupByDomain(addresses: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const addr of addresses) {
    const domain = addr.split('@')[1]?.toLowerCase() ?? '';
    const existing = map.get(domain) ?? [];
    existing.push(addr);
    map.set(domain, existing);
  }
  return map;
}
