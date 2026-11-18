/**
 * Property lookup with the type rules of MS-OXCPRPT/MS-OXCTABL: properties
 * are matched by property ID; a request for PtypString8 gets a PtypString
 * value (and vice versa) converted, PtypUnspecified gets the stored type, any
 * other type mismatch is "not found".
 */
import { PropType, propIdOf, propTypeOf, tag as makeTag, MULTI_VALUE_FLAG } from './tags.js';
import { isPropError, toLatin1, type PropError, type PropValue } from './values.js';

/** Properties of one object, keyed by full property tag. */
export type PropertyBag = Map<number, PropValue | PropError>;

/** The value found for a requested tag: `tag` carries the actual type. */
export type LookupResult =
  | { found: true; tag: number; value: PropValue }
  | { found: true; tag: number; error: number }
  | { found: false };

const STRING_TYPES = new Set<number>([PropType.String, PropType.String8]);
const MV_STRING_TYPES = new Set<number>([PropType.MultipleString, PropType.MultipleString8]);

function convert(value: PropValue, to: number): PropValue {
  if (to === PropType.String8) return toLatin1(String(value));
  if (to === PropType.MultipleString8) return (value as readonly string[]).map(toLatin1);
  return value;
}

/** Finds the stored entry with the requested property ID. */
function findById(bag: PropertyBag, id: number): [number, PropValue | PropError] | undefined {
  for (const entry of bag) if (propIdOf(entry[0]) === id) return entry;
  return undefined;
}

export function lookupProperty(bag: PropertyBag, requested: number): LookupResult {
  const entry = bag.get(requested) !== undefined ? [requested, bag.get(requested)!] as const : findById(bag, propIdOf(requested));
  if (!entry) return { found: false };
  const [storedTag, stored] = entry;
  const want = propTypeOf(requested);
  const have = propTypeOf(storedTag);
  if (isPropError(stored)) return { found: true, tag: want === PropType.Unspecified ? storedTag : requested, error: stored.error };
  if (want === have) return { found: true, tag: storedTag, value: stored };
  if (want === PropType.Unspecified) return { found: true, tag: storedTag, value: stored };
  if (STRING_TYPES.has(want) && STRING_TYPES.has(have)) return { found: true, tag: requested, value: convert(stored, want) };
  if (MV_STRING_TYPES.has(want) && MV_STRING_TYPES.has(have)) return { found: true, tag: requested, value: convert(stored, want) };
  return { found: false };
}

/**
 * The tag a value is returned with for `wantUnicode` (RopGetPropertiesAll):
 * string properties as PtypString when requested, else PtypString8.
 */
export function tagForUnicodePreference(t: number, wantUnicode: boolean): number {
  const type = propTypeOf(t);
  const id = propIdOf(t);
  if (type === PropType.String || type === PropType.String8) return makeTag(id, wantUnicode ? PropType.String : PropType.String8);
  if (type === PropType.MultipleString || type === PropType.MultipleString8) {
    return makeTag(id, (wantUnicode ? PropType.String : PropType.String8) | MULTI_VALUE_FLAG);
  }
  return t;
}

/** Stores a value replacing any entry with the same property ID. */
export function setProperty(bag: PropertyBag, t: number, value: PropValue): void {
  const existing = findById(bag, propIdOf(t));
  if (existing) bag.delete(existing[0]);
  bag.set(t, value);
}

/** Reads a string property (either string type) or undefined. */
export function stringProp(bag: PropertyBag, t: number): string | undefined {
  const r = lookupProperty(bag, makeTag(propIdOf(t), PropType.String));
  return r.found && 'value' in r && typeof r.value === 'string' ? r.value : undefined;
}
