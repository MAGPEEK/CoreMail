import type { Response } from 'express';

/**
 * EAS GetAttachment (Cmd=GetAttachment&AttachmentName=<id>): streams the
 * attachment bytes from object storage. Previously the handler sent the
 * Content-Length header and then an EMPTY body ("In production, stream from
 * MinIO"), so devices could never open attachments.
 */
export interface GetAttachmentDeps {
  findAttachment(id: string, userId: string): Promise<{ mimeType: string; size: number; storagePath: string | null } | null>;
  openStream(storagePath: string): Promise<NodeJS.ReadableStream>;
  warn?(msg: string, err: unknown): void;
}

export async function handleGetAttachment(res: Response, userId: string, attachmentName: string, deps: GetAttachmentDeps): Promise<void> {
  const att = await deps.findAttachment(attachmentName, userId);
  if (!att || !att.storagePath) { res.status(404).send('Not found'); return; }
  let stream: NodeJS.ReadableStream;
  try {
    stream = await deps.openStream(att.storagePath);
  } catch (err) {
    deps.warn?.('EAS attachment object not readable', err);
    res.status(404).send('Not found');
    return;
  }
  res.status(200);
  res.setHeader('Content-Type', att.mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', String(att.size));
  stream.on('error', (err) => {
    deps.warn?.('EAS attachment stream failed', err);
    res.destroy(err instanceof Error ? err : new Error(String(err)));
  });
  stream.pipe(res);
}
