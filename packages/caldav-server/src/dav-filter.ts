/**
 * REPORT filter evaluation (v7.1.0):
 *  - CalDAV `calendar-query` CALDAV:filter (RFC 4791 §9.7): comp-filter, prop-filter,
 *    param-filter, text-match, is-not-defined on the parsed calendar object.
 *  - CardDAV `addressbook-query` CARDDAV:filter (RFC 6352 §10.5): prop-filter with
 *    test=anyof/allof, text-match (match-type), param-filter, is-not-defined.
 *
 * A filter the server cannot evaluate raises `UnsupportedFilterError`, which the
 * caller answers with 403 CALDAV/CARDDAV:supported-filter (or supported-collation)
 * instead of silently returning a superset.
 *
 * VEVENT time ranges are evaluated per row by the CalDAV handler (database range +
 * recurrence expansion); a time-range elsewhere (VALARM, inside prop-filter) is unsupported.
 */
import { getProperties, unescapeText, type IcalComponent } from '@coremail/core/calendar';
import { parseVcard, type VcardProperty } from '@coremail/core/vcard';
import { NS_CALDAV, NS_CARDDAV, type XmlEl } from './dav-utils.js';

export class UnsupportedFilterError extends Error {
  readonly precondition: 'supported-filter' | 'supported-collation';
  constructor(precondition: 'supported-filter' | 'supported-collation', message: string) {
    super(message);
    this.precondition = precondition;
  }
}

const COLLATIONS = new Set(['i;ascii-casemap', 'i;unicode-casemap', 'i;octet']);

interface TextMatch {
  value: string;
  caseless: boolean;
  negate: boolean;
  matchType: 'equals' | 'contains' | 'starts-with' | 'ends-with';
}

function compileTextMatch(el: XmlEl, defaultCollation: string): TextMatch {
  const collation = (el.attrs['collation'] ?? defaultCollation).toLowerCase();
  if (!COLLATIONS.has(collation)) throw new UnsupportedFilterError('supported-collation', `collation ${collation}`);
  const mt = (el.attrs['match-type'] ?? 'contains').toLowerCase();
  if (mt !== 'equals' && mt !== 'contains' && mt !== 'starts-with' && mt !== 'ends-with') {
    throw new UnsupportedFilterError('supported-filter', `match-type ${mt}`);
  }
  return {
    value: el.text,
    caseless: collation !== 'i;octet',
    negate: (el.attrs['negate-condition'] ?? 'no').toLowerCase() === 'yes',
    matchType: mt,
  };
}

function textMatches(tm: TextMatch, candidate: string): boolean {
  const a = tm.caseless ? candidate.toLowerCase() : candidate;
  const b = tm.caseless ? tm.value.toLowerCase() : tm.value;
  const hit = tm.matchType === 'equals' ? a === b
    : tm.matchType === 'starts-with' ? a.startsWith(b)
      : tm.matchType === 'ends-with' ? a.endsWith(b)
        : a.includes(b);
  return tm.negate ? !hit : hit;
}

function only(el: XmlEl, allowed: string[], ns: string): void {
  for (const c of el.children) {
    if (c.ns !== ns || !allowed.includes(c.name)) {
      throw new UnsupportedFilterError('supported-filter', `${c.name} inside ${el.name}`);
    }
  }
}

// ─── CalDAV ──────────────────────────────────────────────────────────────────

type CompPredicate = (parent: IcalComponent) => boolean;

function compileParamFilter(el: XmlEl): (params: Record<string, string>) => boolean {
  only(el, ['is-not-defined', 'text-match'], NS_CALDAV);
  const name = (el.attrs['name'] ?? '').toUpperCase();
  if (el.children.some((c) => c.name === 'is-not-defined')) return (params) => params[name] === undefined;
  const tm = el.children.find((c) => c.name === 'text-match');
  const match = tm ? compileTextMatch(tm, 'i;ascii-casemap') : null;
  return (params) => params[name] !== undefined && (!match || textMatches(match, params[name]!));
}

function compilePropFilter(el: XmlEl): (comp: IcalComponent) => boolean {
  only(el, ['is-not-defined', 'text-match', 'param-filter'], NS_CALDAV);
  const name = (el.attrs['name'] ?? '').toUpperCase();
  if (el.children.some((c) => c.name === 'is-not-defined')) return (comp) => getProperties(comp, name).length === 0;
  const tmEl = el.children.find((c) => c.name === 'text-match');
  const tm = tmEl ? compileTextMatch(tmEl, 'i;ascii-casemap') : null;
  const params = el.children.filter((c) => c.name === 'param-filter').map(compileParamFilter);
  return (comp) => getProperties(comp, name).some((p) =>
    (!tm || textMatches(tm, unescapeText(p.value))) && params.every((f) => f(p.params)));
}

function compileCompFilter(el: XmlEl, depth: number): CompPredicate {
  only(el, ['is-not-defined', 'time-range', 'prop-filter', 'comp-filter'], NS_CALDAV);
  const name = (el.attrs['name'] ?? '').toUpperCase();
  if (el.children.some((c) => c.name === 'is-not-defined')) {
    return (parent) => !parent.components.some((c) => c.name === name);
  }
  // Time ranges are only evaluated for the VEVENT level (by the handler, per row)
  if (el.children.some((c) => c.name === 'time-range') && !(depth === 1 && name === 'VEVENT')) {
    throw new UnsupportedFilterError('supported-filter', `time-range on ${name}`);
  }
  const props = el.children.filter((c) => c.name === 'prop-filter').map(compilePropFilter);
  const comps = el.children.filter((c) => c.name === 'comp-filter').map((c) => compileCompFilter(c, depth + 1));
  const matchesComp = (c: IcalComponent): boolean => props.every((f) => f(c)) && comps.every((f) => f(c));
  return (parent) => parent.components.some((c) => c.name === name && matchesComp(c));
}

/**
 * Compile a CALDAV:filter into a predicate on the parsed VCALENDAR.
 * Throws UnsupportedFilterError for filters the server does not support.
 */
export function compileCalendarFilter(filter: XmlEl | null): (root: IcalComponent) => boolean {
  if (!filter) return () => true;
  only(filter, ['comp-filter'], NS_CALDAV);
  const top = filter.children[0];
  if (!top || filter.children.length !== 1 || (top.attrs['name'] ?? '').toUpperCase() !== 'VCALENDAR') {
    throw new UnsupportedFilterError('supported-filter', 'filter must hold one VCALENDAR comp-filter');
  }
  only(top, ['is-not-defined', 'prop-filter', 'comp-filter'], NS_CALDAV);
  if (top.children.some((c) => c.name === 'is-not-defined')) return () => false;
  const props = top.children.filter((c) => c.name === 'prop-filter').map(compilePropFilter);
  const comps = top.children.filter((c) => c.name === 'comp-filter').map((c) => compileCompFilter(c, 1));
  return (root) => root.name === 'VCALENDAR' && props.every((f) => f(root)) && comps.every((f) => f(root));
}

// ─── CardDAV ─────────────────────────────────────────────────────────────────

function compileCardParamFilter(el: XmlEl): (p: VcardProperty) => boolean {
  only(el, ['is-not-defined', 'text-match'], NS_CARDDAV);
  const name = (el.attrs['name'] ?? '').toUpperCase();
  const values = (p: VcardProperty): string[] | undefined => {
    if (name === 'TYPE') return p.types.length ? p.types : undefined;
    return p.params[name] !== undefined ? [p.params[name]!] : undefined;
  };
  if (el.children.some((c) => c.name === 'is-not-defined')) return (p) => values(p) === undefined;
  const tm = el.children.find((c) => c.name === 'text-match');
  const match = tm ? compileTextMatch(tm, 'i;unicode-casemap') : null;
  return (p) => {
    const v = values(p);
    return v !== undefined && (!match || v.some((x) => textMatches(match, x)));
  };
}

function compileCardPropFilter(el: XmlEl): (props: VcardProperty[]) => boolean {
  only(el, ['is-not-defined', 'text-match', 'param-filter'], NS_CARDDAV);
  const name = (el.attrs['name'] ?? '').toUpperCase();
  const allof = (el.attrs['test'] ?? 'anyof').toLowerCase() === 'allof';
  if (el.children.some((c) => c.name === 'is-not-defined')) return (props) => !props.some((p) => p.name === name);
  const tests: Array<(p: VcardProperty) => boolean> = [
    ...el.children.filter((c) => c.name === 'text-match').map((c) => {
      const tm = compileTextMatch(c, 'i;unicode-casemap');
      return (p: VcardProperty) => textMatches(tm, unescapeText(p.value));
    }),
    ...el.children.filter((c) => c.name === 'param-filter').map(compileCardParamFilter),
  ];
  return (props) => props.filter((p) => p.name === name).some((p) =>
    tests.length === 0 || (allof ? tests.every((t) => t(p)) : tests.some((t) => t(p))));
}

/** Compile a CARDDAV:filter into a predicate on vCard text. */
export function compileAddressbookFilter(filter: XmlEl | null): (vcard: string) => boolean {
  if (!filter) return () => true;
  only(filter, ['prop-filter'], NS_CARDDAV);
  const allof = (filter.attrs['test'] ?? 'anyof').toLowerCase() === 'allof';
  const tests = filter.children.map(compileCardPropFilter);
  if (tests.length === 0) return () => true;
  return (vcard) => {
    const props = parseVcard(vcard)?.properties ?? [];
    return allof ? tests.every((t) => t(props)) : tests.some((t) => t(props));
  };
}
