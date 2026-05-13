import { authenticate } from 'mailauth';
import { createLogger } from '@coremail/core';

const log = createLogger('security-filter:spf-dkim');

export interface AuthResult {
  spf: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';
  dkim: 'pass' | 'fail' | 'none';
  dmarc: 'pass' | 'fail' | 'none';
  arc:   'pass' | 'fail' | 'none';
  summary: string;
  receivedHeader: string;
}

export async function authenticateMail(
  rawMessage: Buffer,
  senderIp: string,
  hostname: string,
): Promise<AuthResult> {
  try {
    const result = await authenticate(rawMessage, {
      ip: senderIp,
      helo: hostname,
      sender: hostname,
      mta: hostname,
    });

    const spf   = (result.spf !== false ? (result.spf.status?.result ?? 'none') : 'none') as AuthResult['spf'];
    const dkim  = result.dkim?.results?.[0]?.status?.result === 'pass' ? 'pass' : result.dkim?.results?.length ? 'fail' : 'none';
    const dmarc = (result.dmarc !== false ? (result.dmarc.status?.result === 'pass' ? 'pass' : result.dmarc.status?.result ? 'fail' : 'none') : 'none') as AuthResult['dmarc'];
    const arc   = (result.arc !== false ? (result.arc.status?.result === 'pass' ? 'pass' : result.arc.status?.result ? 'fail' : 'none') : 'none') as AuthResult['arc'];

    log.debug({ senderIp, spf, dkim, dmarc, arc }, 'Auth result');

    return {
      spf,
      dkim,
      dmarc,
      arc,
      summary: buildSummary({ spf, dkim, dmarc, arc }),
      receivedHeader: typeof result.receivedChain === 'string' ? result.receivedChain : '',
    };
  } catch (err) {
    log.error({ err, senderIp }, 'mailauth error');
    return {
      spf: 'temperror',
      dkim: 'none',
      dmarc: 'none',
      arc: 'none',
      summary: 'Authentication check failed',
      receivedHeader: '',
    };
  }
}

function buildSummary(r: Pick<AuthResult, 'spf' | 'dkim' | 'dmarc' | 'arc'>): string {
  return `spf=${r.spf} dkim=${r.dkim} dmarc=${r.dmarc} arc=${r.arc}`;
}

export function shouldRejectByDmarc(
  dmarc: AuthResult['dmarc'],
  dmarcPolicy: string,
): boolean {
  if (dmarc === 'pass') return false;
  return dmarcPolicy === 'reject' || dmarcPolicy === 'quarantine';
}
