import { prisma } from '@coremail/storage';
import { soapEnvelope } from '../soap/response.js';
import type { EwsUser } from '../auth/middleware.js';

export async function resolveNames(
  request: Record<string, unknown>,
  _user: EwsUser,
): Promise<string> {
  

  const unresolvedEntry = String(request['UnresolvedEntry'] ?? '');
  if (!unresolvedEntry || unresolvedEntry.length < 2) {
    return soapEnvelope((body) => {
      body
        .ele('m:ResolveNamesResponse')
        .ele('m:ResponseMessages')
        .ele('m:ResolveNamesResponseMessage', { ResponseClass: 'Success' })
        .ele('m:ResponseCode').txt('NoError').up()
        .ele('m:ResolutionSet', { TotalItemsInView: '0', IncludesLastItemInRange: 'true' });
    });
  }

  const query = `%${unresolvedEntry.toLowerCase()}%`;
  const users = await prisma.user.findMany({
    where: {
      active: true,
      OR: [
        { email: { contains: query, mode: 'insensitive' } },
        { displayName: { contains: query, mode: 'insensitive' } },
      ],
    },
    take: 20,
    select: { email: true, displayName: true },
  });

  const contacts = await prisma.contact.findMany({
    where: {
      OR: [
        { email: { contains: query, mode: 'insensitive' } },
        { displayName: { contains: query, mode: 'insensitive' } },
      ],
    },
    take: 10,
    select: { email: true, displayName: true, company: true },
  });

  const results = [
    ...users.map((u: { email: string; displayName: string }) => ({ email: u.email, name: u.displayName, company: '' })),
    ...contacts.map((c: { email: string; displayName: string; company: string }) => ({ email: c.email, name: c.displayName, company: c.company })),
  ];

  return soapEnvelope((body) => {
    const response = body
      .ele('m:ResolveNamesResponse')
      .ele('m:ResponseMessages')
      .ele('m:ResolveNamesResponseMessage', { ResponseClass: 'Success' });

    response.ele('m:ResponseCode').txt(results.length > 0 ? 'NoError' : 'ErrorNameResolutionNoResults');

    const resolutionSet = response.ele('m:ResolutionSet', {
      TotalItemsInView: String(results.length),
      IncludesLastItemInRange: 'true',
    });

    for (const r of results) {
      resolutionSet
        .ele('t:Resolution')
        .ele('t:Mailbox')
        .ele('t:Name').txt(r.name).up()
        .ele('t:EmailAddress').txt(r.email).up()
        .ele('t:RoutingType').txt('SMTP').up()
        .ele('t:MailboxType').txt('Mailbox');
    }
  });
}
