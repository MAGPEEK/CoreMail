import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma, announceUserEvent } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { countVcards, parseVcard, vcardFields, vcardUid, type VcardFields } from '@coremail/core/vcard';
import {
  DAV_ALLOW,
  DAV_COMPLIANCE,
  appendCurrentUserPrincipal,
  appendPropResults,
  asyncHandler,
  checkPreconditions,
  collectionTag,
  etagFor,
  newMultistatus,
  parseProppatch,
  parseReportRequest,
  preconditionHeaders,
  principalHref,
  requireOwnPath,
  resourceIdFromHref,
  sendDavError,
  sendMultistatus,
  syncTokenFor,
  type XmlNode,
} from '../dav-utils.js';
import { compileAddressbookFilter, UnsupportedFilterError } from '../dav-filter.js';

const log = createLogger('carddav');

export const carddavRouter: RouterType = Router();

/** Display name of the (single) default address book. */
export const ADDRESSBOOK_DISPLAY_NAME = 'Contacts';

function addressbookBase(userId: string): string {
  return `/dav/addressbooks/${userId}`;
}

function contactHref(userId: string, id: string): string {
  return `${addressbookBase(userId)}/default/${id}.vcf`;
}

/** CTag / sync-token of the default address book: contact count + newest updatedAt. */
async function addressbookTag(userId: string): Promise<string> {
  const agg = await prisma.contact.aggregate({
    where: { userId },
    _count: { _all: true },
    _max: { updatedAt: true },
  });
  return collectionTag(agg._count._all, agg._max.updatedAt ?? null);
}

/**
 * Extract the indexed fields from a vCard (folded lines, groups, parameters, escaping).
 * v7.1.0: all `contacts` columns (phone, mobile, email2, department, title, notes)
 * are indexed, not only name/email/company.
 */
export function parseVcardFields(vcard: string): VcardFields {
  return vcardFields(vcard);
}

// OPTIONS — the CalDAV router answers first for /dav/*; identical header set
carddavRouter.options('*', (_req: Request, res: Response) => {
  res.set({ Allow: DAV_ALLOW, DAV: DAV_COMPLIANCE, 'Content-Length': '0' });
  res.status(204).send();
});

function appendAddressbookProps(prop: XmlNode, req: Request, userId: string, ctag: string): void {
  prop.ele('d:resourcetype').ele('d:collection').up().ele('ab:addressbook');
  prop.ele('d:displayname').txt(ADDRESSBOOK_DISPLAY_NAME);
  prop.ele('cs:getctag').txt(ctag);
  prop.ele('d:sync-token').txt(syncTokenFor(ctag));
  prop.ele('ab:supported-address-data').ele('ab:address-data-type', { 'content-type': 'text/vcard', version: '3.0' });
  const reports = prop.ele('d:supported-report-set');
  for (const r of ['ab:addressbook-query', 'ab:addressbook-multiget', 'd:sync-collection']) {
    reports.ele('d:supported-report').ele('d:report').ele(r);
  }
  prop.ele('d:owner').ele('d:href').txt(principalHref(userId));
  const cups = prop.ele('d:current-user-privilege-set');
  for (const p of ['d:all', 'd:read', 'd:write', 'd:write-content', 'd:bind', 'd:unbind']) cups.ele('d:privilege').ele(p);
  appendCurrentUserPrincipal(prop, req);
}

function appendContactResponse(doc: XmlNode, req: Request, href: string, etag: string): void {
  const r = doc.ele('d:response');
  r.ele('d:href').txt(href);
  const ps = r.ele('d:propstat');
  const prop = ps.ele('d:prop');
  prop.ele('d:getetag').txt(etag);
  prop.ele('d:getcontenttype').txt('text/vcard; charset=utf-8');
  prop.ele('d:resourcetype');
  appendCurrentUserPrincipal(prop, req);
  ps.ele('d:status').txt('HTTP/1.1 200 OK');
}

/** PROPPATCH where nothing is writable: 403 for every property (RFC 4918 §9.2). */
function sendReadOnlyProppatch(req: Request, res: Response, href: string): void {
  const ops = parseProppatch(req.body);
  if (!ops) { res.status(400).send('Bad Request — DAV:propertyupdate expected'); return; }
  const doc = newMultistatus();
  const r = doc.ele('d:response');
  r.ele('d:href').txt(href);
  appendPropResults(r, ops.map((o) => ({ prop: o.prop, status: 403 })));
  sendMultistatus(res, doc);
}

// PROPFIND /addressbooks/:userId — the address book home (+ the default book with Depth: 1)
carddavRouter.all('/addressbooks/:userId', asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId } = req.params as { userId: string };
  if (req.method === 'PROPPATCH') { sendReadOnlyProppatch(req, res, `${addressbookBase(userId)}/`); return; }
  if (req.method !== 'PROPFIND') { res.set('Allow', 'OPTIONS, PROPFIND, PROPPATCH').status(405).send('Method Not Allowed'); return; }

  const doc = newMultistatus();
  // RFC 4918 §9.1: the response describes the request-URI itself first
  const home = doc.ele('d:response');
  home.ele('d:href').txt(`${addressbookBase(userId)}/`);
  const homeStat = home.ele('d:propstat');
  const homeProp = homeStat.ele('d:prop');
  homeProp.ele('d:resourcetype').ele('d:collection');
  homeProp.ele('d:owner').ele('d:href').txt(principalHref(userId));
  appendCurrentUserPrincipal(homeProp, req);
  homeStat.ele('d:status').txt('HTTP/1.1 200 OK');

  if (req.get('Depth') !== '0') {
    const r = doc.ele('d:response');
    r.ele('d:href').txt(`${addressbookBase(userId)}/default/`);
    const ps = r.ele('d:propstat');
    appendAddressbookProps(ps.ele('d:prop'), req, userId, await addressbookTag(userId));
    ps.ele('d:status').txt('HTTP/1.1 200 OK');
  }

  sendMultistatus(res, doc);
}));

// /addressbooks/:userId/default — ONE handler for PROPFIND + REPORT (a PROPFIND-only handler
// used to answer 405 before the REPORT handler registered later could run).
carddavRouter.all('/addressbooks/:userId/default', asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId } = req.params as { userId: string };

  if (req.method === 'PROPFIND') {
    const doc = newMultistatus();
    const self = doc.ele('d:response');
    self.ele('d:href').txt(`${addressbookBase(userId)}/default/`);
    const selfStat = self.ele('d:propstat');
    appendAddressbookProps(selfStat.ele('d:prop'), req, userId, await addressbookTag(userId));
    selfStat.ele('d:status').txt('HTTP/1.1 200 OK');

    if (req.get('Depth') !== '0') {
      const contacts = await prisma.contact.findMany({ where: { userId }, select: { id: true, updatedAt: true } });
      for (const contact of contacts) {
        appendContactResponse(doc, req, contactHref(userId, contact.id), etagFor(contact.id, contact.updatedAt));
      }
    }
    sendMultistatus(res, doc);
    return;
  }

  if (req.method === 'PROPPATCH') { sendReadOnlyProppatch(req, res, `${addressbookBase(userId)}/default/`); return; }

  if (req.method === 'REPORT') {
    const report = parseReportRequest(req.body);
    const doc = newMultistatus();
    const select = { id: true, vcardData: true, updatedAt: true } as const;
    const append = (c: { id: string; vcardData: string; updatedAt: Date }): void => {
      const r = doc.ele('d:response');
      r.ele('d:href').txt(contactHref(userId, c.id));
      const ps = r.ele('d:propstat');
      const prop = ps.ele('d:prop');
      prop.ele('d:getetag').txt(etagFor(c.id, c.updatedAt));
      if (report.wantsData) prop.ele('ab:address-data').txt(c.vcardData);
      ps.ele('d:status').txt('HTTP/1.1 200 OK');
    };

    if (report.kind === 'addressbook-multiget') {
      const ids = report.hrefs.map((h) => resourceIdFromHref(h, '.vcf'));
      const rows = await prisma.contact.findMany({ where: { userId, id: { in: ids } }, select });
      const byId = new Map(rows.map((c) => [c.id, c]));
      report.hrefs.forEach((href, i) => {
        const row = byId.get(ids[i] ?? '');
        if (row) { append(row); return; }
        const r = doc.ele('d:response');
        r.ele('d:href').txt(href);
        r.ele('d:status').txt('HTTP/1.1 404 Not Found');
      });
    } else if (report.kind === 'sync-collection') {
      const current = syncTokenFor(await addressbookTag(userId));
      if (report.syncToken && report.syncToken !== current) {
        sendDavError(res, 403, 'd:valid-sync-token');
        return;
      }
      if (!report.syncToken) (await prisma.contact.findMany({ where: { userId }, select })).forEach(append);
      doc.ele('d:sync-token').txt(current);
    } else if (report.kind === 'addressbook-query') {
      // RFC 6352 §8.6: the filter is evaluated (v7.1.0 — previously every card was returned)
      let matches: (vcard: string) => boolean;
      try {
        matches = compileAddressbookFilter(report.filter);
      } catch (err) {
        if (err instanceof UnsupportedFilterError) { sendDavError(res, 403, `ab:${err.precondition}`); return; }
        throw err;
      }
      const hits = (await prisma.contact.findMany({ where: { userId }, select })).filter((c) => matches(c.vcardData));
      const limit = report.limit;
      (limit !== null ? hits.slice(0, limit) : hits).forEach(append);
      if (limit !== null && hits.length > limit) {
        // RFC 6352 §8.6.1: truncated result → 507 for the request-URI
        const r = doc.ele('d:response');
        r.ele('d:href').txt(`${addressbookBase(userId)}/default/`);
        r.ele('d:status').txt('HTTP/1.1 507 Insufficient Storage');
        r.ele('d:error').ele('d:number-of-matches-within-limits');
      }
    } else {
      sendDavError(res, 403, 'd:supported-report');
      return;
    }
    sendMultistatus(res, doc);
    return;
  }

  res.set('Allow', 'OPTIONS, PROPFIND, PROPPATCH, REPORT').status(405).send('Method Not Allowed');
}));

// GET /addressbooks/:userId/default/:contactId.vcf — fetch vCard
carddavRouter.get('/addressbooks/:userId/default/:contactId', asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId, contactId } = req.params as { userId: string; contactId: string };

  const id = contactId.replace(/\.vcf$/, '');
  const contact = await prisma.contact.findFirst({ where: { id, userId } });
  if (!contact) { res.status(404).send('Not Found'); return; }

  const etag = etagFor(contact.id, contact.updatedAt);
  const pre = checkPreconditions('GET', preconditionHeaders(req), etag);
  if (pre !== null) { res.set('ETag', etag).status(pre).send(); return; }

  res.set({ 'Content-Type': 'text/vcard; charset=utf-8', ETag: etag });
  res.send(contact.vcardData);
}));

/** UID of another contact of the user that already uses `uid` (null when unique). */
async function findUidOwner(userId: string, uid: string, selfId: string): Promise<string | null> {
  const candidates = await prisma.contact.findMany({
    where: { userId, vcardData: { contains: uid } },
    select: { id: true, vcardData: true },
  });
  return candidates.find((c) => c.id !== selfId && vcardUid(c.vcardData) === uid)?.id ?? null;
}

// PUT /addressbooks/:userId/default/:contactId.vcf — create or update contact
carddavRouter.put('/addressbooks/:userId/default/:contactId', asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId, contactId } = req.params as { userId: string; contactId: string };

  const id = contactId.replace(/\.vcf$/, '');
  const vcardData = typeof req.body === 'string' ? req.body : '';
  if (!vcardData) { res.status(400).send('Bad Request'); return; }
  // RFC 6352 §5.1 / §6.3.2.1 valid-address-data: exactly one vCard per resource
  if (countVcards(vcardData) !== 1 || !parseVcard(vcardData)) { sendDavError(res, 403, 'ab:valid-address-data'); return; }

  const existing = await prisma.contact.findFirst({ where: { id }, select: { id: true, userId: true, updatedAt: true } });
  if (existing && existing.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const pre = checkPreconditions('PUT', preconditionHeaders(req), existing ? etagFor(existing.id, existing.updatedAt) : null);
  if (pre !== null) { res.status(412).send('Precondition Failed'); return; }

  // RFC 6352 §6.3.2.1 no-uid-conflict: the UID is unique within the address book.
  // (A card without UID is accepted: older REST-created cards had none.)
  const uid = vcardUid(vcardData);
  if (uid) {
    const clash = await findUidOwner(userId, uid, id);
    if (clash) {
      sendDavError(res, 409, 'ab:no-uid-conflict', (el) => { el.ele('d:href').txt(contactHref(userId, clash)); });
      return;
    }
  }

  const fields = vcardFields(vcardData);
  if (existing) {
    const saved = await prisma.contact.update({
      where: { id },
      data: { vcardData, ...fields },
      select: { id: true, updatedAt: true },
    });
    log.info({ userId, contactId: id }, 'CardDAV contact updated');
    announceUserEvent(userId, { type: 'contacts', action: 'update', ids: [id] });
    res.set('ETag', etagFor(saved.id, saved.updatedAt)).status(204).send();
  } else {
    const saved = await prisma.contact.create({
      data: { id, userId, vcardData, ...fields },
      select: { id: true, updatedAt: true },
    });
    log.info({ userId, contactId: id }, 'CardDAV contact created');
    announceUserEvent(userId, { type: 'contacts', action: 'create', ids: [id] });
    res.set('ETag', etagFor(saved.id, saved.updatedAt)).status(201).send();
  }
}));

// DELETE /addressbooks/:userId/default/:contactId.vcf — delete contact
carddavRouter.delete('/addressbooks/:userId/default/:contactId', asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId, contactId } = req.params as { userId: string; contactId: string };

  const id = contactId.replace(/\.vcf$/, '');
  const contact = await prisma.contact.findFirst({ where: { id, userId }, select: { id: true, updatedAt: true } });
  if (!contact) { res.status(404).send('Not Found'); return; }

  if (checkPreconditions('DELETE', preconditionHeaders(req), etagFor(contact.id, contact.updatedAt)) !== null) {
    res.status(412).send('Precondition Failed');
    return;
  }

  await prisma.contact.delete({ where: { id } });
  log.info({ userId, contactId: id }, 'CardDAV contact deleted');
  announceUserEvent(userId, { type: 'contacts', action: 'delete', ids: [id] });
  res.status(204).send();
}));

// PROPFIND / PROPPATCH on an address object resource (RFC 4918 §9.1)
carddavRouter.all('/addressbooks/:userId/default/:contactId', asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId, contactId } = req.params as { userId: string; contactId: string };
  const id = contactId.replace(/\.vcf$/, '');
  if (req.method !== 'PROPFIND' && req.method !== 'PROPPATCH') {
    res.set('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH').status(405).send('Method Not Allowed');
    return;
  }
  const contact = await prisma.contact.findFirst({ where: { id, userId }, select: { id: true, updatedAt: true } });
  if (!contact) { res.status(404).send('Not Found'); return; }
  if (req.method === 'PROPPATCH') { sendReadOnlyProppatch(req, res, contactHref(userId, id)); return; }
  const doc = newMultistatus();
  appendContactResponse(doc, req, contactHref(userId, id), etagFor(contact.id, contact.updatedAt));
  sendMultistatus(res, doc);
}));
