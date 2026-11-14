import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { unfoldLines, parseContentLine, unescapeText } from '@coremail/core/calendar';
import { create } from 'xmlbuilder2';
import {
  asyncHandler,
  checkPreconditions,
  collectionTag,
  etagFor,
  parseReportRequest,
  preconditionHeaders,
  resourceIdFromHref,
  syncTokenFor,
} from '../dav-utils.js';

const log = createLogger('carddav');

export const carddavRouter: RouterType = Router();

const NS_DAV = 'DAV:';
const NS_CARDDAV = 'urn:ietf:params:xml:ns:carddav';
const NS_CS = 'http://calendarserver.org/ns/';

type XmlNode = ReturnType<typeof create>;

function xmlResponse(root: XmlNode): string {
  return root.end({ prettyPrint: false });
}

function addressbookBase(userId: string): string {
  return `/dav/addressbooks/${userId}`;
}

function contactHref(userId: string, id: string): string {
  return `${addressbookBase(userId)}/default/${id}.vcf`;
}

function newMultistatus(): XmlNode {
  return create({ version: '1.0', encoding: 'utf-8' })
    .ele('d:multistatus', { 'xmlns:d': NS_DAV, 'xmlns:ab': NS_CARDDAV, 'xmlns:cs': NS_CS });
}

function sendMultistatus(res: Response, doc: XmlNode): void {
  res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(doc));
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

/** Extract the indexed fields from a vCard (folded lines, parameters, escaping). */
export function parseVcardFields(vcard: string): { displayName: string; email: string; company: string } {
  let displayName = '';
  let email = '';
  let company = '';
  for (const line of unfoldLines(vcard)) {
    const p = parseContentLine(line);
    if (!p) continue;
    const name = p.name.replace(/^[^.]+\./, ''); // strip group prefix (item1.EMAIL)
    if (name === 'FN' && !displayName) displayName = unescapeText(p.value).trim();
    else if (name === 'EMAIL' && !email) email = unescapeText(p.value).trim();
    else if (name === 'ORG' && !company) company = unescapeText((p.value.split(/(?<!\\);/)[0] ?? '')).trim();
  }
  return { displayName, email, company };
}

// OPTIONS
carddavRouter.options('*', (_req: Request, res: Response) => {
  res.set({
    Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT',
    DAV: '1, 2, 3, addressbook',
    'Content-Length': '0',
  });
  res.status(204).send();
});

function appendAddressbookProps(prop: XmlNode, ctag: string): void {
  prop.ele('d:resourcetype').ele('d:collection').up().ele('ab:addressbook');
  prop.ele('d:displayname').txt('Contacts');
  prop.ele('cs:getctag').txt(ctag);
  prop.ele('d:sync-token').txt(syncTokenFor(ctag));
  const reports = prop.ele('d:supported-report-set');
  for (const r of ['ab:addressbook-query', 'ab:addressbook-multiget', 'd:sync-collection']) {
    reports.ele('d:supported-report').ele('d:report').ele(r);
  }
}

// PROPFIND /:userId — default address book
carddavRouter.all('/addressbooks/:userId', asyncHandler(async (req: Request, res: Response) => {
  if (req.method !== 'PROPFIND') { res.status(405).send('Method Not Allowed'); return; }

  const { userId } = req.params as { userId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const doc = newMultistatus();
  const r = doc.ele('d:response');
  r.ele('d:href').txt(`${addressbookBase(userId)}/default/`);
  const ps = r.ele('d:propstat');
  appendAddressbookProps(ps.ele('d:prop'), await addressbookTag(userId));
  ps.ele('d:status').txt('HTTP/1.1 200 OK');

  sendMultistatus(res, doc);
}));

// /:userId/default — ONE handler for PROPFIND + REPORT (a PROPFIND-only handler
// used to answer 405 before the REPORT handler registered later could run).
carddavRouter.all('/addressbooks/:userId/default', asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params as { userId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  if (req.method === 'PROPFIND') {
    const doc = newMultistatus();
    const self = doc.ele('d:response');
    self.ele('d:href').txt(`${addressbookBase(userId)}/default/`);
    const selfStat = self.ele('d:propstat');
    appendAddressbookProps(selfStat.ele('d:prop'), await addressbookTag(userId));
    selfStat.ele('d:status').txt('HTTP/1.1 200 OK');

    if (req.get('Depth') !== '0') {
      const contacts = await prisma.contact.findMany({ where: { userId }, select: { id: true, updatedAt: true } });
      for (const contact of contacts) {
        const r = doc.ele('d:response');
        r.ele('d:href').txt(contactHref(userId, contact.id));
        const ps = r.ele('d:propstat');
        const prop = ps.ele('d:prop');
        prop.ele('d:getetag').txt(etagFor(contact.id, contact.updatedAt));
        prop.ele('d:getcontenttype').txt('text/vcard; charset=utf-8');
        prop.ele('d:resourcetype');
        ps.ele('d:status').txt('HTTP/1.1 200 OK');
      }
    }
    sendMultistatus(res, doc);
    return;
  }

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
        res.status(403).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(
          create({ version: '1.0', encoding: 'utf-8' }).ele('d:error', { 'xmlns:d': NS_DAV }).ele('d:valid-sync-token').up(),
        ));
        return;
      }
      if (!report.syncToken) (await prisma.contact.findMany({ where: { userId }, select })).forEach(append);
      doc.ele('d:sync-token').txt(current);
    } else {
      // addressbook-query (filters are not evaluated: all cards are returned)
      (await prisma.contact.findMany({ where: { userId }, select })).forEach(append);
    }
    sendMultistatus(res, doc);
    return;
  }

  res.set('Allow', 'OPTIONS, PROPFIND, REPORT').status(405).send('Method Not Allowed');
}));

// GET /:userId/default/:contactId.vcf — fetch vCard
carddavRouter.get('/addressbooks/:userId/default/:contactId', asyncHandler(async (req: Request, res: Response) => {
  const { userId, contactId } = req.params as { userId: string; contactId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const id = contactId.replace(/\.vcf$/, '');
  const contact = await prisma.contact.findFirst({ where: { id, userId } });
  if (!contact) { res.status(404).send('Not Found'); return; }

  const etag = etagFor(contact.id, contact.updatedAt);
  const pre = checkPreconditions('GET', preconditionHeaders(req), etag);
  if (pre !== null) { res.set('ETag', etag).status(pre).send(); return; }

  res.set({ 'Content-Type': 'text/vcard; charset=utf-8', ETag: etag });
  res.send(contact.vcardData);
}));

// PUT /:userId/default/:contactId.vcf — create or update contact
carddavRouter.put('/addressbooks/:userId/default/:contactId', asyncHandler(async (req: Request, res: Response) => {
  const { userId, contactId } = req.params as { userId: string; contactId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const id = contactId.replace(/\.vcf$/, '');
  const vcardData = typeof req.body === 'string' ? req.body : '';
  if (!vcardData || !/BEGIN:VCARD/i.test(vcardData)) { res.status(400).send('Bad Request'); return; }

  const { displayName, email, company } = parseVcardFields(vcardData);

  const existing = await prisma.contact.findFirst({ where: { id }, select: { id: true, userId: true, updatedAt: true } });
  if (existing && existing.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const pre = checkPreconditions('PUT', preconditionHeaders(req), existing ? etagFor(existing.id, existing.updatedAt) : null);
  if (pre !== null) { res.status(412).send('Precondition Failed'); return; }

  if (existing) {
    const saved = await prisma.contact.update({
      where: { id },
      data: { vcardData, displayName, email, company },
      select: { id: true, updatedAt: true },
    });
    log.info({ userId, contactId: id }, 'CardDAV contact updated');
    res.set('ETag', etagFor(saved.id, saved.updatedAt)).status(204).send();
  } else {
    const saved = await prisma.contact.create({
      data: { id, userId, vcardData, displayName, email, company },
      select: { id: true, updatedAt: true },
    });
    log.info({ userId, contactId: id }, 'CardDAV contact created');
    res.set('ETag', etagFor(saved.id, saved.updatedAt)).status(201).send();
  }
}));

// DELETE /:userId/default/:contactId.vcf — delete contact
carddavRouter.delete('/addressbooks/:userId/default/:contactId', asyncHandler(async (req: Request, res: Response) => {
  const { userId, contactId } = req.params as { userId: string; contactId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const id = contactId.replace(/\.vcf$/, '');
  const contact = await prisma.contact.findFirst({ where: { id, userId }, select: { id: true, updatedAt: true } });
  if (!contact) { res.status(404).send('Not Found'); return; }

  if (checkPreconditions('DELETE', preconditionHeaders(req), etagFor(contact.id, contact.updatedAt)) !== null) {
    res.status(412).send('Precondition Failed');
    return;
  }

  await prisma.contact.delete({ where: { id } });
  log.info({ userId, contactId: id }, 'CardDAV contact deleted');
  res.status(204).send();
}));
