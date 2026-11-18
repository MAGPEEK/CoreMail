/** Lazy loading of a stored message's content into its server object. */
import { applyContent, attachmentBag, recipientsFromRow } from '../../objects/props.js';
import type { MessageState } from '../../objects/state.js';
import type { MailStore } from '../../store/types.js';

/** Bodies, Bcc and the attachment list of a stored message (once per object). */
export async function ensureContent(store: MailStore, message: MessageState): Promise<void> {
  if (message.contentLoaded || !message.summary) return;
  const content = await store.loadContent(message.summary);
  applyContent(message.props, content);
  message.recipients = recipientsFromRow(message.summary, content);
  message.attachments = content.attachments.map((record, num) => ({
    num, props: attachmentBag(num, record), record, data: null, saved: true,
  }));
  message.nextAttachNum = message.attachments.length;
  message.contentLoaded = true;
}
