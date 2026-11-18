/**
 * From a message server object to the message CoreMail stores or sends:
 * subject, plain/HTML body (PidTagHtml decoded with PidTagInternetCodepage),
 * recipients by type, the chosen From address and the saved attachments.
 */
import { lookupProperty, stringProp } from '../../props/bag.js';
import { RecipientKind, Tag } from '../../props/tags.js';
import type { MessageState } from '../../objects/state.js';
import type { ComposedMessage, MailStore } from '../../store/types.js';

const CODEPAGE_UTF8 = 65001;
const CODEPAGE_LATIN1 = 28591;

export function decodeHtml(html: Buffer, codepage: number | undefined): string {
  if (codepage === undefined || codepage === CODEPAGE_UTF8) return html.toString('utf8');
  if (codepage === CODEPAGE_LATIN1) return html.toString('latin1');
  try {
    return new TextDecoder(`windows-${codepage}`).decode(html);
  } catch {
    return html.toString('latin1');
  }
}

function htmlBody(message: MessageState): string {
  const html = lookupProperty(message.props, Tag.Html);
  if (!html.found || !('value' in html) || !Buffer.isBuffer(html.value)) return '';
  const cp = lookupProperty(message.props, Tag.InternetCodepage);
  return decodeHtml(html.value, cp.found && 'value' in cp && typeof cp.value === 'number' ? cp.value : undefined);
}

function subjectOf(message: MessageState): string {
  const subject = stringProp(message.props, Tag.Subject);
  if (subject !== undefined) return subject;
  return (stringProp(message.props, Tag.SubjectPrefix) ?? '') + (stringProp(message.props, Tag.NormalizedSubject) ?? '');
}

function requestedFrom(message: MessageState): string | null {
  const smtp = stringProp(message.props, Tag.SentRepresentingSmtpAddress);
  if (smtp) return smtp;
  const type = stringProp(message.props, Tag.SentRepresentingAddressType);
  const addr = stringProp(message.props, Tag.SentRepresentingEmailAddress);
  return type?.toUpperCase() === 'SMTP' && addr ? addr : null;
}

export async function composeMessage(store: MailStore, message: MessageState): Promise<ComposedMessage> {
  const byType = (t: number): string[] => message.recipients.filter((r) => r.type === t && r.email).map((r) => r.email);
  const attachments: ComposedMessage['attachments'] = [];
  for (const a of message.attachments.filter((x) => x.saved)) {
    const content = a.data ?? (a.record ? await store.loadAttachment(a.record.id) : null);
    if (!content) continue;
    const filename = stringProp(a.props, Tag.AttachLongFilename) ?? stringProp(a.props, Tag.AttachFilename) ?? `attachment-${a.num}`;
    const contentId = stringProp(a.props, Tag.AttachContentId) ?? null;
    attachments.push({
      filename,
      mimeType: stringProp(a.props, Tag.AttachMimeTag) ?? 'application/octet-stream',
      contentId,
      inline: contentId !== null,
      content,
    });
  }
  return {
    subject: subjectOf(message),
    bodyText: stringProp(message.props, Tag.Body) ?? '',
    bodyHtml: htmlBody(message),
    from: requestedFrom(message),
    to: byType(RecipientKind.To),
    cc: byType(RecipientKind.Cc),
    bcc: byType(RecipientKind.Bcc),
    inReplyTo: stringProp(message.props, Tag.InReplyToId) ?? null,
    attachments,
  };
}
