import { parseStringPromise } from 'xml2js';
import { createLogger } from '@coremail/core';

const log = createLogger('ews:parser');

export interface SoapEnvelope {
  action: string;
  requestBody: Record<string, unknown>;
  raw: Record<string, unknown>;
}

const NS_MESSAGES = 'http://schemas.microsoft.com/exchange/services/2006/messages';
const NS_SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';

export async function parseSoapRequest(xmlBody: string): Promise<SoapEnvelope | null> {
  try {
    const parsed = await parseStringPromise(xmlBody, {
      explicitArray: false,
      ignoreAttrs: false,
      tagNameProcessors: [(name) => name.replace(/^.*:/, '')],
    });

    const envelope = parsed['Envelope'] as Record<string, unknown> | undefined;
    if (!envelope) return null;

    const body = envelope['Body'] as Record<string, unknown> | undefined;
    if (!body) return null;

    // First key in Body is the action name
    const action = Object.keys(body)[0];
    if (!action) return null;

    const requestBody = body[action] as Record<string, unknown>;

    return { action, requestBody, raw: parsed as Record<string, unknown> };
  } catch (err) {
    log.error({ err }, 'Failed to parse SOAP request');
    return null;
  }
}
