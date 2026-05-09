import { Router, type Request, type Response } from 'express';
import { getPrisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { create } from 'xmlbuilder2';

const log = createLogger('carddav');

export const carddavRouter = Router();

const NS_DAV = 'DAV:';
const NS_CARDDAV = 'urn:ietf:params:xml:ns:carddav';

function xmlResponse(root: ReturnType<typeof create>): string {
  return root.end({ prettyPrint: false });
}

function addressbookBase(userId: string): string {
  return `/dav/addressbooks/${userId}`;
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

// PROPFIND /:userId — default address book
carddavRouter.all('/addressbooks/:userId', async (req: Request, res: Response) => {
  if (req.method !== 'PROPFIND') { res.status(405).send('Method Not Allowed'); return; }

  const { userId } = req.params as { userId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const prisma = getPrisma();
  const contactCount = await prisma.contact.count({ where: { userId } });

  const doc = create({ version: '1.0', encoding: 'utf-8' })
    .ele('d:multistatus', { 'xmlns:d': NS_DAV, 'xmlns:ab': NS_CARDDAV });

  const r = doc.ele('d:response');
  r.ele('d:href').txt(`${addressbookBase(userId)}/default/`);
  const ps = r.ele('d:propstat');
  const prop = ps.ele('d:prop');
  prop.ele('d:resourcetype').ele('d:collection').up().ele('ab:addressbook');
  prop.ele('d:displayname').txt('Contacts');
  prop.ele('d:getctag').txt(String(contactCount));
  ps.ele('d:status').txt('HTTP/1.1 200 OK');

  res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(doc));
});

// PROPFIND /:userId/default — list contacts
carddavRouter.all('/addressbooks/:userId/default', async (req: Request, res: Response) => {
  if (req.method !== 'PROPFIND') { res.status(405).send('Method Not Allowed'); return; }

  const { userId } = req.params as { userId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const prisma = getPrisma();
  const contacts = await prisma.contact.findMany({
    where: { userId },
    select: { id: true },
  });

  const doc = create({ version: '1.0', encoding: 'utf-8' })
    .ele('d:multistatus', { 'xmlns:d': NS_DAV, 'xmlns:ab': NS_CARDDAV });

  for (const contact of contacts) {
    const r = doc.ele('d:response');
    r.ele('d:href').txt(`${addressbookBase(userId)}/default/${contact.id}.vcf`);
    const ps = r.ele('d:propstat');
    const prop = ps.ele('d:prop');
    prop.ele('d:getetag').txt(`"${contact.id}"`);
    prop.ele('d:getcontenttype').txt('text/vcard; charset=utf-8');
    ps.ele('d:status').txt('HTTP/1.1 200 OK');
  }

  res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(doc));
});

// GET /:userId/default/:contactId.vcf — fetch vCard
carddavRouter.get('/addressbooks/:userId/default/:contactId', async (req: Request, res: Response) => {
  const { userId, contactId } = req.params as { userId: string; contactId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const id = contactId.replace(/\.vcf$/, '');
  const prisma = getPrisma();
  const contact = await prisma.contact.findFirst({ where: { id, userId } });
  if (!contact) { res.status(404).send('Not Found'); return; }

  res.set({ 'Content-Type': 'text/vcard; charset=utf-8', ETag: `"${id}"` });
  res.send(contact.vcardData);
});

// PUT /:userId/default/:contactId.vcf — create or update contact
carddavRouter.put('/addressbooks/:userId/default/:contactId', async (req: Request, res: Response) => {
  const { userId, contactId } = req.params as { userId: string; contactId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const id = contactId.replace(/\.vcf$/, '');
  const vcardData = typeof req.body === 'string' ? req.body : '';
  if (!vcardData) { res.status(400).send('Bad Request'); return; }

  // Parse FN and EMAIL from vCard
  const fnMatch = /^FN:(.+)$/m.exec(vcardData);
  const emailMatch = /^EMAIL[^:]*:(.+)$/m.exec(vcardData);
  const orgMatch = /^ORG:(.+)$/m.exec(vcardData);

  const displayName = fnMatch?.[1]?.trim() ?? '';
  const email = emailMatch?.[1]?.trim() ?? '';
  const company = orgMatch?.[1]?.split(';')[0]?.trim() ?? '';

  const prisma = getPrisma();
  const existing = await prisma.contact.findFirst({ where: { id, userId } });

  if (existing) {
    await prisma.contact.update({
      where: { id },
      data: { vcardData, displayName, email, company },
    });
    log.info({ userId, contactId: id }, 'CardDAV contact updated');
    res.set('ETag', `"${id}"`).status(204).send();
  } else {
    await prisma.contact.create({
      data: { id, userId, vcardData, displayName, email, company },
    });
    log.info({ userId, contactId: id }, 'CardDAV contact created');
    res.set('ETag', `"${id}"`).status(201).send();
  }
});

// DELETE /:userId/default/:contactId.vcf — delete contact
carddavRouter.delete('/addressbooks/:userId/default/:contactId', async (req: Request, res: Response) => {
  const { userId, contactId } = req.params as { userId: string; contactId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const id = contactId.replace(/\.vcf$/, '');
  const prisma = getPrisma();
  const contact = await prisma.contact.findFirst({ where: { id, userId } });
  if (!contact) { res.status(404).send('Not Found'); return; }

  await prisma.contact.delete({ where: { id } });
  log.info({ userId, contactId: id }, 'CardDAV contact deleted');
  res.status(204).send();
});

// REPORT — addressbook-query (fetch all vCards for sync)
carddavRouter.all('/addressbooks/:userId/default', async (req: Request, res: Response, next) => {
  if (req.method !== 'REPORT') { next(); return; }

  const { userId } = req.params as { userId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const prisma = getPrisma();
  const contacts = await prisma.contact.findMany({
    where: { userId },
    select: { id: true, vcardData: true },
  });

  const doc = create({ version: '1.0', encoding: 'utf-8' })
    .ele('d:multistatus', { 'xmlns:d': NS_DAV, 'xmlns:ab': NS_CARDDAV });

  for (const contact of contacts) {
    const r = doc.ele('d:response');
    r.ele('d:href').txt(`${addressbookBase(userId)}/default/${contact.id}.vcf`);
    const ps = r.ele('d:propstat');
    ps.ele('d:prop')
      .ele('d:getetag').txt(`"${contact.id}"`).up()
      .ele('ab:address-data').txt(contact.vcardData);
    ps.ele('d:status').txt('HTTP/1.1 200 OK');
  }

  res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(doc));
});
