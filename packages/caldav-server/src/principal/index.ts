/**
 * DAV discovery (v7.1.0): context root + principal resources, so clients can find
 * the calendar/address book homes from just the server name and credentials:
 *
 *   /.well-known/caldav|carddav  → 301 /dav/                       (RFC 6764 §5)
 *   PROPFIND /dav/               → DAV:current-user-principal       (RFC 5397)
 *   PROPFIND /dav/principals/<id>/ → calendar-home-set, addressbook-home-set,
 *                                  calendar-user-address-set, principal-URL
 *                                  (RFC 4791 §6.2.1, RFC 6352 §7.1.1, RFC 3744 §4.2)
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage';
import {
  appendCurrentUserPrincipal,
  asyncHandler,
  newMultistatus,
  principalHref,
  sendMultistatus,
} from '../dav-utils.js';

export const principalRouter: RouterType = Router();

const PRINCIPALS = '/dav/principals/';

function collectionResponse(req: Request, res: Response, href: string): void {
  const doc = newMultistatus();
  const r = doc.ele('d:response');
  r.ele('d:href').txt(href);
  const ps = r.ele('d:propstat');
  const prop = ps.ele('d:prop');
  prop.ele('d:resourcetype').ele('d:collection');
  appendCurrentUserPrincipal(prop, req);
  prop.ele('d:principal-collection-set').ele('d:href').txt(PRINCIPALS);
  ps.ele('d:status').txt('HTTP/1.1 200 OK');
  sendMultistatus(res, doc);
}

// /dav and /dav/ — the context path the well-known URIs point to
principalRouter.all('/', (req: Request, res: Response, next) => {
  if (req.method === 'OPTIONS') { next(); return; }
  if (req.method === 'PROPFIND') { collectionResponse(req, res, '/dav/'); return; }
  // Browsers / legacy clients: straight to the own calendar home
  res.redirect(301, `/dav/calendars/${encodeURIComponent(req.davUser?.userId ?? '')}/`);
});

principalRouter.all('/principals', (req: Request, res: Response, next) => {
  if (req.method === 'OPTIONS') { next(); return; }
  if (req.method !== 'PROPFIND') { res.set('Allow', 'OPTIONS, PROPFIND').status(405).send('Method Not Allowed'); return; }
  collectionResponse(req, res, PRINCIPALS);
});

// The own principal only — other users' principals are not browsable
principalRouter.all('/principals/:userId', asyncHandler(async (req: Request, res: Response, next) => {
  if (req.method === 'OPTIONS') { next(); return; }
  if (req.method !== 'PROPFIND') { res.set('Allow', 'OPTIONS, PROPFIND').status(405).send('Method Not Allowed'); return; }
  const { userId } = req.params as { userId: string };
  if (!req.davUser || req.davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const [user, aliases] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true } }),
    prisma.emailAlias.findMany({ where: { targetUserId: userId, active: true }, select: { address: true } }),
  ]);
  if (!user) { res.status(404).send('Not Found'); return; }

  const doc = newMultistatus();
  const r = doc.ele('d:response');
  r.ele('d:href').txt(principalHref(userId));
  const ps = r.ele('d:propstat');
  const prop = ps.ele('d:prop');
  prop.ele('d:resourcetype').ele('d:collection').up().ele('d:principal');
  prop.ele('d:displayname').txt(user.displayName || user.email);
  prop.ele('d:principal-URL').ele('d:href').txt(principalHref(userId));
  prop.ele('d:principal-collection-set').ele('d:href').txt(PRINCIPALS);
  appendCurrentUserPrincipal(prop, req);
  prop.ele('c:calendar-home-set').ele('d:href').txt(`/dav/calendars/${encodeURIComponent(userId)}/`);
  prop.ele('ab:addressbook-home-set').ele('d:href').txt(`/dav/addressbooks/${encodeURIComponent(userId)}/`);
  const cuas = prop.ele('c:calendar-user-address-set');
  for (const addr of [user.email, ...aliases.map((a) => a.address)]) cuas.ele('d:href').txt(`mailto:${addr}`);
  ps.ele('d:status').txt('HTTP/1.1 200 OK');
  sendMultistatus(res, doc);
}));
