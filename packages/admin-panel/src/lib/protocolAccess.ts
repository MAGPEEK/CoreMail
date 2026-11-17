/**
 * 9.4: per-protocol access switches (admin API /admin/protocol-access) — the
 * level view the API returns, and the pure logic of the BCP editor: what a
 * switch resolves to and which switches a save sends.
 */

export const PROTOCOLS = ['imap', 'pop3', 'smtp', 'activesync', 'jmap', 'dav', 'webmail', 'mapi'] as const;
export type Protocol = typeof PROTOCOLS[number];

export const PROTOCOL_SETTINGS = ['inherit', 'on', 'off'] as const;
export type ProtocolSetting = typeof PROTOCOL_SETTINGS[number];

export type ProtocolSettings = Record<Protocol, ProtocolSetting>;

/** GET/PUT /admin/protocol-access[/domains/:id|/users/:id]. */
export interface ProtocolLevelView {
  level: 'global' | 'domain' | 'user';
  id?: string;
  protocols: Protocol[];
  /** The switches stored on this level. */
  settings: ProtocolSettings;
  /** What `inherit` resolves to on this level. */
  inherited: Record<Protocol, boolean>;
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

/** Turning off Webmail on the server or a domain level locks out every account without an admin role. */
export function locksOutWebmail(view: Pick<ProtocolLevelView, 'level' | 'inherited'>, draft: ProtocolSettings): boolean {
  return view.level !== 'user' && !effectiveOf(draft.webmail, view.inherited.webmail);
}
