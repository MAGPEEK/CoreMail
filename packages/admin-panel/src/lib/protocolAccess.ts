/**
 * 9.4: per-protocol access switches (admin API /admin/protocol-access) — the
 * level view the API returns, and the pure logic of the BCP editor: what a
 * switch resolves to and which switches a save sends.
 */

export const PROTOCOLS = ['imap', 'pop3', 'smtp', 'activesync', 'jmap', 'dav', 'webmail', 'mapi'] as const;
export type Protocol = typeof PROTOCOLS[number];

export const PROTOCOL_SETTINGS = ['inherit', 'on', 'off'] as const;
export type ProtocolSetting = typeof PROTOCOL_SETTINGS[number];

/** The options of a level: the server level is two-state (it has nothing to inherit from). */
export function settingsForLevel(level: ProtocolLevelView['level']): readonly ProtocolSetting[] {
  return level === 'global' ? ['on', 'off'] : PROTOCOL_SETTINGS;
}

export type ProtocolSettings = Record<Protocol, ProtocolSetting>;

/** GET/PUT /admin/protocol-access[/domains/:id|/users/:id]. */
export interface ProtocolLevelView {
  level: 'global' | 'domain' | 'user';
  id?: string;
  protocols: Protocol[];
  /** The switches of this level (server level: always on / off). */
  settings: ProtocolSettings;
  /** What `inherit` resolves to on this level (server level: the built-in defaults). */
  inherited: Record<Protocol, boolean>;
  /** w2b: where `inherited` comes from (absent on older servers). */
  inheritedFrom?: Record<Protocol, 'default' | 'server' | 'domain'>;
  effective: Record<Protocol, boolean>;
  /** PUT only: users whose effective access changed. */
  changedUsers?: number;
}

/** Effective value of one switch in the editor (draft over the inherited value). */
export function effectiveOf(setting: ProtocolSetting, inherited: boolean): boolean {
  return setting === 'inherit' ? inherited : setting === 'on';
}

/** The switches that differ between the stored and the edited state (the PUT body). */
export function changedSettings(saved: ProtocolSettings, draft: ProtocolSettings): Partial<ProtocolSettings> {
  const out: Partial<ProtocolSettings> = {};
  for (const p of PROTOCOLS) if (draft[p] !== saved[p]) out[p] = draft[p];
  return out;
}

/** The level that decides a switch: the server, the domain or the mailbox itself. */
export type EffectiveReason = 'server' | 'domain' | 'user';

/**
 * Which level decides the effective value of one switch in the editor (w2b:
 * "aus (Domain)", "an (serverweit)"): an explicit on/off decides on its own
 * level, `inherit` on the level it inherits from. Null when an older server
 * does not say where a mailbox inherits from.
 */
export function effectiveReason(
  view: Pick<ProtocolLevelView, 'level' | 'inheritedFrom'>,
  protocol: Protocol,
  setting: ProtocolSetting,
): EffectiveReason | null {
  if (setting !== 'inherit' || view.level === 'global') return view.level === 'global' ? 'server' : view.level;
  if (view.level === 'domain') return 'server';
  const from = view.inheritedFrom?.[protocol];
  if (from === undefined) return null;
  return from === 'domain' ? 'domain' : 'server';
}

/** Turning off Webmail on the server or a domain level locks out every account without an admin role. */
export function locksOutWebmail(view: Pick<ProtocolLevelView, 'level' | 'inherited'>, draft: ProtocolSettings): boolean {
  return view.level !== 'user' && !effectiveOf(draft.webmail, view.inherited.webmail);
}
