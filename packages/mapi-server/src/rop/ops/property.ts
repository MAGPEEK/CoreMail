/**
 * Property ROPs (MS-OXCPRPT 2.2.2–2.2.13): RopGetPropertiesSpecific,
 * RopGetPropertiesAll, RopSetProperties, RopGetPropertyIdsFromNames,
 * RopGetNamesFromPropertyIds.
 *
 * Values larger than PropertySizeLimit (default 8 KB) come back as
 * ecMAPIOOM (0x8007000E) so the client reads them with RopOpenStream; values
 * that would overflow the output buffer are degraded the same way.
 */
import { BufferWriter } from '../../wire/writer.js';
import { Ec, RopError, RopId } from '../codes.js';
import {
  assertMemory, assertWritable, defineRop, NeedsMoreSpace, objectAt, okResponse, type RopContext, type RopDef,
} from '../context.js';
import { valueBytes } from '../../objects/footprint.js';
import { lookupProperty, setProperty, tagForUnicodePreference, type LookupResult, type PropertyBag } from '../../props/bag.js';
import { PropType, propIdOf, propTypeOf, tag as makeTag, Tag } from '../../props/tags.js';
import { encodedSize, readTaggedValue, writeTaggedValue, isPropError, type TaggedValue } from '../../props/values.js';
import { writePropertyRow } from '../../props/row.js';
import { NameKind, readPropertyName, writePropertyName, type PropertyName } from '../../props/named.js';
import { folderBag, storeBag } from '../../objects/props.js';
import { ensureContent } from './content.js';
import { folderNode, refreshView } from './common.js';
import { messageBagWithRecipients } from './message.js';
import type { ServerObject } from '../../objects/state.js';

const DEFAULT_VALUE_LIMIT = 0x2000;
/** RopId + index + ReturnValue + row flag. */
const SPECIFIC_HEADER = 7;

/** Current properties of a server object. */
export async function bagOf(ctx: RopContext, obj: ServerObject, want: readonly number[] = []): Promise<PropertyBag> {
  switch (obj.kind) {
    case 'logon': return storeBag(obj.logon);
    case 'folder': {
      await refreshView(ctx.store, obj.logon);
      return folderBag(obj.logon, folderNode(obj.logon, obj.counter));
    }
    case 'message':
      await ensureContent(ctx.store, obj.message);
      return messageBagWithRecipients(obj.message);
    case 'attachment': {
      const bag = new Map(obj.attachment.props);
      const a = obj.attachment;
      if (want.some((t) => propIdOf(t) === propIdOf(Tag.AttachDataBinary))) {
        const data = a.data ?? (a.record ? await ctx.store.loadAttachment(a.record.id) : null);
        if (data) bag.set(Tag.AttachDataBinary, data);
      }
      return bag;
    }
    default:
      throw new RopError(Ec.NotSupported, `${obj.kind} objects have no properties`);
  }
}

/** Lookup that returns strings of PtypUnspecified columns in the preferred width. */
function lookupFor(bag: PropertyBag, column: number, wantUnicode: boolean): LookupResult {
  const r = lookupProperty(bag, column);
  if (!r.found || propTypeOf(column) !== PropType.Unspecified || !('value' in r)) return r;
  return lookupProperty(bag, tagForUnicodePreference(r.tag, wantUnicode));
}

function tooLarge(r: LookupResult, limit: number): boolean {
  return r.found && 'value' in r && encodedSize(propTypeOf(r.tag), r.value) > limit;
}

interface SpecificReq { inputIndex: number; sizeLimit: number; wantUnicode: boolean; tags: number[] }

export const ropGetPropertiesSpecific = defineRop<SpecificReq>({
  id: RopId.GetPropertiesSpecific,
  name: 'RopGetPropertiesSpecific',
  parse(r) {
    const inputIndex = r.u8();
    const sizeLimit = r.u16();
    const wantUnicode = r.u16() !== 0;
    const n = r.u16();
    const tags: number[] = [];
    for (let i = 0; i < n; i++) tags.push(r.u32());
    return { inputIndex, sizeLimit, wantUnicode, tags };
  },
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const bag = await bagOf(ctx, objectAt(ctx, req.inputIndex), req.tags);
    const limit = req.sizeLimit > 0 ? req.sizeLimit : DEFAULT_VALUE_LIMIT;
    const results = new Map<number, LookupResult>();
    for (const t of req.tags) {
      const r = lookupFor(bag, t, req.wantUnicode);
      results.set(t, tooLarge(r, limit) ? { found: true, tag: t, error: Ec.OutOfMemory } : r);
    }
    for (;;) {
      const w = okResponse(RopId.GetPropertiesSpecific, req.inputIndex);
      writePropertyRow(w, req.tags, (t) => results.get(t)!);
      if (w.length <= ctx.budget) return w.toBuffer();
      const largest = [...results.entries()]
        .filter(([, r]) => r.found && 'value' in r)
        .sort((a, b) => valueSize(b[1]) - valueSize(a[1]))[0];
      if (!largest) throw new NeedsMoreSpace(SPECIFIC_HEADER + req.tags.length * 6);
      results.set(largest[0], { found: true, tag: largest[0], error: Ec.OutOfMemory });
    }
  },
});

function valueSize(r: LookupResult): number {
  return r.found && 'value' in r ? encodedSize(propTypeOf(r.tag), r.value) : 0;
}

interface AllReq { inputIndex: number; sizeLimit: number; wantUnicode: boolean }

export const ropGetPropertiesAll = defineRop<AllReq>({
  id: RopId.GetPropertiesAll,
  name: 'RopGetPropertiesAll',
  parse: (r) => ({ inputIndex: r.u8(), sizeLimit: r.u16(), wantUnicode: r.u16() !== 0 }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const bag = await bagOf(ctx, objectAt(ctx, req.inputIndex));
    const limit = req.sizeLimit > 0 ? req.sizeLimit : DEFAULT_VALUE_LIMIT;
    const values: TaggedValue[] = [];
    for (const [t, v] of bag) {
      if (propTypeOf(t) === PropType.Object) continue;
      const out = tagForUnicodePreference(t, req.wantUnicode);
      if (isPropError(v)) { values.push({ tag: makeTag(propIdOf(t), PropType.ErrorCode), value: v.error }); continue; }
      const r = lookupProperty(bag, out);
      if (!r.found || !('value' in r)) continue;
      values.push(encodedSize(propTypeOf(out), r.value) > limit
        ? { tag: makeTag(propIdOf(t), PropType.ErrorCode), value: Ec.OutOfMemory }
        : { tag: out, value: r.value });
    }
    const w = okResponse(RopId.GetPropertiesAll, req.inputIndex).u16(values.length);
    for (const v of values) writeTaggedValue(w, v);
    if (w.length > ctx.budget) throw new NeedsMoreSpace(w.length);
    return w.toBuffer();
  },
});

interface SetReq { inputIndex: number; values: TaggedValue[] }

export const ropSetProperties = defineRop<SetReq>({
  id: RopId.SetProperties,
  name: 'RopSetProperties',
  parse(r) {
    const inputIndex = r.u8();
    const body = r.slice(r.u16());
    const n = body.u16();
    const values: TaggedValue[] = [];
    for (let i = 0; i < n; i++) values.push(readTaggedValue(body));
    return { inputIndex, values };
  },
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const obj = objectAt(ctx, req.inputIndex);
    const incoming = req.values.reduce((n, v) => n + valueBytes(v.value), 0);
    if (obj.kind === 'message') {
      assertWritable(obj.logon);
      if (obj.message.readOnly || obj.message.submitted) throw new RopError(Ec.AccessDenied, 'message is read-only');
      assertMemory(ctx, incoming);
      for (const v of req.values) setProperty(obj.message.props, v.tag, v.value);
    } else if (obj.kind === 'attachment') {
      assertWritable(obj.logon);
      assertMemory(ctx, incoming);
      for (const v of req.values) {
        if (v.tag === Tag.AttachDataBinary && Buffer.isBuffer(v.value)) obj.attachment.data = v.value;
        else setProperty(obj.attachment.props, v.tag, v.value);
      }
    } else if (obj.kind !== 'folder' && obj.kind !== 'logon') {
      throw new RopError(Ec.NotSupported, `${obj.kind} objects have no properties`);
    }
    // Folder and store properties are not stored by CoreMail; the change is accepted without effect.
    return okResponse(RopId.SetProperties, req.inputIndex).u16(0).toBuffer();
  },
});

const FLAG_CREATE = 0x02;

interface IdsFromNamesReq { inputIndex: number; create: boolean; names: PropertyName[] }

export const ropGetPropertyIdsFromNames = defineRop<IdsFromNamesReq>({
  id: RopId.GetPropertyIdsFromNames,
  name: 'RopGetPropertyIdsFromNames',
  parse(r) {
    const inputIndex = r.u8();
    const create = (r.u8() & FLAG_CREATE) !== 0;
    const n = r.u16();
    const names: PropertyName[] = [];
    for (let i = 0; i < n; i++) names.push(readPropertyName(r));
    return { inputIndex, create, names };
  },
  responseIndex: (req) => req.inputIndex,
  /**
   * MS-OXCPRPT, Processing RopGetPropertyIdsFromNames: no names on a Logon
   * object → every registered ID; new IDs only with the Create flag on a
   * writable mailbox (a read-only delegate must not fill the owner's ID space);
   * unknown names → 0 with ecWarnWithErrors; ID space full → ecMAPIOOM.
   */
  async execute(ctx, req) {
    const obj = objectAt(ctx, req.inputIndex);
    const { named, mailbox } = obj.logon;
    let ids: number[];
    if (req.names.length === 0 && obj.kind === 'logon') {
      ids = named.registeredIds();
    } else {
      const create = req.create && !mailbox.readOnly;
      const found = req.names.map((n) => named.lookup(n, create));
      if (found.includes('exhausted')) throw new RopError(Ec.OutOfMemory, 'named property ID space exhausted');
      ids = found.map((x) => (typeof x === 'number' ? x : 0));
    }
    const w = new BufferWriter(16 + ids.length * 2)
      .u8(RopId.GetPropertyIdsFromNames).u8(req.inputIndex)
      .u32(ids.includes(0) ? Ec.WarnWithErrors : Ec.Success)
      .u16(ids.length);
    for (const id of ids) w.u16(id);
    if (w.length > ctx.budget) throw new NeedsMoreSpace(w.length);
    return w.toBuffer();
  },
});

interface NamesFromIdsReq { inputIndex: number; ids: number[] }

/** An ID without a name: the Kind byte 0xFF only (MS-OXCPRPT 3.2.5.9). */
const NO_NAME: PropertyName = { kind: NameKind.None, guid: Buffer.alloc(0) };

export const ropGetNamesFromPropertyIds = defineRop<NamesFromIdsReq>({
  id: RopId.GetNamesFromPropertyIds,
  name: 'RopGetNamesFromPropertyIds',
  parse(r) {
    const inputIndex = r.u8();
    const n = r.u16();
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(r.u16());
    return { inputIndex, ids };
  },
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { named } = objectAt(ctx, req.inputIndex).logon;
    const w = okResponse(RopId.GetNamesFromPropertyIds, req.inputIndex).u16(req.ids.length);
    for (const id of req.ids) writePropertyName(w, named.nameOf(id) ?? NO_NAME);
    if (w.length > ctx.budget) throw new NeedsMoreSpace(w.length);
    return w.toBuffer();
  },
});

export const propertyRops: RopDef[] = [
  ropGetPropertiesSpecific, ropGetPropertiesAll, ropSetProperties, ropGetPropertyIdsFromNames, ropGetNamesFromPropertyIds,
];
