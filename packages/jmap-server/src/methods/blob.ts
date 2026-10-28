/**
 * Blob/* (RFC 9404): upload (inline), get (content via method), lookup.
 */
import { createHash } from 'node:crypto';
import { registerMethod } from '../dispatcher.js';
import { CAP_BLOB } from '../capabilities.js';
import { MethodError, requestTooLarge, setError } from '../errors.js';
import { LIMITS } from '../settings.js';
import { lookupBlobReferences, resolveBlob, storeUpload } from '../blobs.js';
import type { JsonObject } from '../types.js';

registerMethod('Blob/upload', CAP_BLOB, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const create = (args['create'] ?? {}) as Record<string, JsonObject>;
  if (typeof create !== 'object' || Array.isArray(create)) throw new MethodError('invalidArguments', 'create must be an object');
  if (Object.keys(create).length > LIMITS.maxObjectsInSet) throw requestTooLarge();
  const created: JsonObject = {}; const notCreated: JsonObject = {};
  for (const [cid, obj] of Object.entries(create)) {
    try {
      const sources = obj['data'];
      if (!Array.isArray(sources)) throw setError('invalidProperties', 'data must be an array', ['data']);
      if (sources.length > 64) throw setError('tooLarge', 'too many data sources');
      const chunks: Buffer[] = [];
      for (const s of sources as JsonObject[]) {
        if (typeof s['data:asText'] === 'string') chunks.push(Buffer.from(s['data:asText'], 'utf8'));
        else if (typeof s['data:asBase64'] === 'string') chunks.push(Buffer.from(s['data:asBase64'], 'base64'));
        else if (typeof s['blobId'] === 'string') {
          const src = await resolveBlob(account, ctx.resolveId(s['blobId']));
          if (!src) throw setError('blobNotFound', `blob ${s['blobId']} not found`);
          const off = typeof s['offset'] === 'number' ? Math.max(0, Math.trunc(s['offset'])) : 0;
          const len = typeof s['length'] === 'number' ? Math.max(0, Math.trunc(s['length'])) : src.buffer.length - off;
          if (off > src.buffer.length) throw setError('invalidProperties', 'offset beyond blob size', ['data']);
          chunks.push(src.buffer.subarray(off, off + len));
        } else throw setError('invalidProperties', 'data source needs data:asText, data:asBase64 or blobId', ['data']);
      }
      const buf = Buffer.concat(chunks);
      if (buf.length > LIMITS.maxSizeUpload) throw setError('tooLarge');
      const stored = await storeUpload(account, buf, typeof obj['type'] === 'string' ? obj['type'] : 'application/octet-stream');
      ctx.createdIds.set(cid, stored.blobId);
      created[cid] = { id: stored.blobId, type: stored.type, size: stored.size };
    } catch (e) {
      notCreated[cid] = e && typeof e === 'object' && 'type' in e ? (e as JsonObject) : setError('serverFail', e instanceof Error ? e.message : undefined);
    }
  }
  return {
    accountId: account.accountId,
    created: Object.keys(created).length ? created : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
  };
});

registerMethod('Blob/get', CAP_BLOB, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const ids = args['ids'];
  if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) throw new MethodError('invalidArguments', 'ids must be Id[]');
  if (ids.length > LIMITS.maxObjectsInGet) throw requestTooLarge();
  const props = Array.isArray(args['properties']) ? (args['properties'] as string[]) : ['data:asBase64', 'size'];
  const offset = typeof args['offset'] === 'number' ? Math.max(0, Math.trunc(args['offset'])) : 0;
  const length = typeof args['length'] === 'number' ? Math.max(0, Math.trunc(args['length'])) : null;
  const list: JsonObject[] = []; const notFound: string[] = [];
  for (const id of ids as string[]) {
    const blob = await resolveBlob(account, ctx.resolveId(id));
    if (!blob) { notFound.push(id); continue; }
    const slice = blob.buffer.subarray(offset, length === null ? undefined : offset + length);
    const isTruncated = offset + slice.length < blob.buffer.length || offset > blob.buffer.length;
    const out: JsonObject = { id };
    for (const p of props) {
      switch (p) {
        case 'data:asText': {
          const text = slice.toString('utf8');
          const ok = !text.includes('�');
          out[p] = ok ? text : null;
          if (!ok) out['isEncodingProblem'] = true;
          break;
        }
        case 'data:asBase64': out[p] = slice.toString('base64'); break;
        case 'data': {
          const text = slice.toString('utf8');
          if (text.includes('�')) { out['data:asBase64'] = slice.toString('base64'); out['isEncodingProblem'] = true; }
          else out['data:asText'] = text;
          break;
        }
        case 'digest:sha': out[p] = createHash('sha1').update(slice).digest('base64'); break;
        case 'digest:sha-256': out[p] = createHash('sha256').update(slice).digest('base64'); break;
        case 'size': out[p] = blob.buffer.length; break;
        default: throw new MethodError('invalidArguments', `unknown property ${p}`);
      }
    }
    if (isTruncated) out['isTruncated'] = true;
    list.push(out);
  }
  return { accountId: account.accountId, list, notFound };
});

registerMethod('Blob/lookup', CAP_BLOB, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const ids = args['ids']; const typeNames = args['typeNames'];
  if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) throw new MethodError('invalidArguments', 'ids must be Id[]');
  if (!Array.isArray(typeNames) || !typeNames.every((t) => typeof t === 'string')) throw new MethodError('invalidArguments', 'typeNames must be String[]');
  for (const t of typeNames as string[]) if (!['Email', 'Mailbox', 'Thread'].includes(t)) throw new MethodError('unknownDataType', `unsupported type ${t}`);
  const list: JsonObject[] = []; const notFound: string[] = [];
  for (const id of ids as string[]) {
    const matched = await lookupBlobReferences(account, id, typeNames as string[]);
    if (!matched) { notFound.push(id); continue; }
    list.push({ id, matchedIds: matched });
  }
  return { accountId: account.accountId, list, notFound: notFound.length ? notFound : null };
});
