import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Terminal, Package, MessageSquare, Clock,
  Network, Plus, Trash2, CheckCircle, Info, SendHorizonal,
  Loader2, XCircle, Globe, Copy, Check, RefreshCw, AlertCircle, Printer,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { errorMessage } from '../lib/errors.js';
import { smtpGreetingPreview } from '../lib/smtpBanner.js';
import { WriteGuard } from '../components/Can.js';
import { DeviceRelaySection } from '../components/DeviceRelaySection.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SmtpSettings {
  extStarttls:          boolean;
  extAuthPlain:         boolean;
  extAuthLogin:         boolean;
  extPipelining:        boolean;
  extSize:              boolean;
  ext8bitmime:          boolean;
  extEnhancedStatus:    boolean;
  // The following DB fields are kept for backwards compatibility but are
  // ignored by the server:
  //   extAuthCramMd5 — not implemented
  //   extSmtputf8, extDsn, extChunking — implemented (9.0), switched via the
  //   SMTP_EXT_SMTPUTF8 / SMTP_EXT_DSN / SMTP_EXT_CHUNKING environment variables
  localDeliveryEnabled: boolean;
  bannerOverride:       boolean;
  bannerText:           string;
  // relaying* and outboundFilterEnabled are still stored but not shown and never
  // evaluated (no outbound scanning). IP-based relay for devices is the separate
  // "Geräte-Relay" (DeviceRelaySection, own settings row).
  greylistingEnabled:   boolean;
  greylistWaitSec:      number;
  greylistTtlHours:     number;
  greylistWhitelist:    string[];
  maxConnections:       number;
  maxConnectionsPerIp:  number;
  maxMessageSizeMb:     number;
  maxRecipients:        number;
  connectionTimeoutSec: number;
  greetingDelaySec:     number;
  maxAuthFailures:      number;
  // Outgoing delivery
  outboundMode:          'mx' | 'smarthost';
  smarthostHost:         string;
  smarthostPort:         number;
  smarthostTls:          boolean;
  smarthostImplicitTls:  boolean;
  smarthostUsername:     string;
  smarthostPassword:     string;
}

// ── Sub-Navigation ────────────────────────────────────────────────────────────

type Section = 'esmtp' | 'delivery' | 'banner' | 'greylisting' | 'connection' | 'outgoing' | 'devicerelay' | 'dns';

const SUB_NAV: { id: Section; label: string; icon: React.ElementType }[] = [
  { id: 'esmtp',       label: 'ESMTP-Befehle',    icon: Terminal },
  { id: 'delivery',    label: 'Lokale Zustellung', icon: Package },
  { id: 'outgoing',    label: 'Ausgehende Mail',   icon: SendHorizonal },
  { id: 'banner',      label: 'SMTP-Banner',       icon: MessageSquare },
  { id: 'greylisting', label: 'Greylisting',       icon: Clock },
  { id: 'connection',  label: 'Verbindung',        icon: Network },
  { id: 'devicerelay', label: 'Geräte-Relay',      icon: Printer },
  { id: 'dns',         label: 'DNS-Einträge',      icon: Globe },
];

// ── Shared helpers ────────────────────────────────────────────────────────────

function SaveBtn({ onClick, pending }: { onClick: () => void; pending: boolean }) {
  return (
    <button onClick={onClick} disabled={pending} className="btn-primary text-sm disabled:opacity-50">
      {pending ? 'Speichern…' : 'Speichern'}
    </button>
  );
}

function ToggleRow({ label, desc, value, onChange, warn }: {
  label: string; desc?: string; value: boolean;
  onChange: (v: boolean) => void; warn?: string;
}) {
  return (
    <div className="flex items-start justify-between py-3 border-b border-line last:border-0">
      <div className="flex-1 pr-6">
        <p className="text-sm font-medium text-fg">{label}</p>
        {desc && <p className="text-xs text-fg-subtle mt-0.5">{desc}</p>}
        {warn && value === false && (
          <p className="text-xs text-warning-fg mt-0.5 flex items-center gap-1">
            <Info size={10} /> {warn}
          </p>
        )}
      </div>
      <Toggle active={value} onToggle={() => onChange(!value)} />
    </div>
  );
}

function NumInput({ label, desc, value, onChange, min, max, unit }: {
  label: string; desc?: string; value: number;
  onChange: (v: number) => void; min: number; max: number; unit?: string;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-line last:border-0">
      <div>
        <p className="text-sm font-medium text-fg">{label}</p>
        {desc && <p className="text-xs text-fg-subtle mt-0.5">{desc}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <input
          type="number" min={min} max={max} value={value}
          onChange={e => onChange(parseInt(e.target.value, 10) || min)}
          className="w-24 border border-line-strong rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent-fg"
        />
        {unit && <span className="text-xs text-fg-subtle w-10">{unit}</span>}
      </div>
    </div>
  );
}

// ── ESMTP Extension row with risk badge ───────────────────────────────────────

type Risk = 'safe' | 'caution' | 'advanced';
interface ExtDef {
  key: keyof SmtpSettings;
  label: string;
  rfc: string;
  desc: string;
  risk: Risk;
  warnOff?: string;
}

const EXT_DEFS: ExtDef[] = [
  { key: 'extStarttls',       label: 'STARTTLS',         rfc: 'RFC 3207',  risk: 'safe',
    desc: 'Verschlüsselung der SMTP-Verbindung via TLS aufwerten',
    warnOff: 'Deaktivieren senkt die Verbindungssicherheit erheblich' },
  { key: 'extAuthPlain',      label: 'AUTH PLAIN',       rfc: 'RFC 4616',  risk: 'safe',
    desc: 'Anmeldung mit Base64-kodiertem Benutzernamen + Passwort (nur über TLS sicher)' },
  { key: 'extAuthLogin',      label: 'AUTH LOGIN',       rfc: 'RFC draft', risk: 'safe',
    desc: 'Legacy-Authentifizierungsmethode — von vielen älteren Mail-Clients verwendet' },
  { key: 'extPipelining',     label: 'PIPELINING',       rfc: 'RFC 2920',  risk: 'safe',
    desc: 'Mehrere SMTP-Befehle in einem TCP-Paket senden — beschleunigt Verbindungen' },
  { key: 'extSize',           label: 'SIZE',             rfc: 'RFC 1870',  risk: 'safe',
    desc: 'Maximale Nachrichtengröße im EHLO-Greeting ankündigen' },
  { key: 'ext8bitmime',       label: '8BITMIME',         rfc: 'RFC 6152',  risk: 'safe',
    desc: '8-Bit-Daten in SMTP-Nachrichten ohne MIME-Encoding erlauben' },
  { key: 'extEnhancedStatus', label: 'ENHANCEDSTATUSCODES', rfc: 'RFC 2034', risk: 'safe',
    desc: 'Erweiterte SMTP-Statuscodes (z.B. 5.7.1) für bessere Fehlerdiagnose' },
  // Deliberately NOT available as toggles:
  //   CRAM-MD5 (RFC 2195/4954) — not implemented (handleAuth only knows PLAIN+LOGIN, 504 on CRAM-MD5)
  //   SMTPUTF8 (RFC 6531), DSN (RFC 3461), CHUNKING + BINARYMIME (RFC 3030) — implemented
  //   (9.0), on by default, switched via SMTP_EXT_* environment variables; shown read-only
  //   in ENV_EXT_DEFS below.
];

/** Implemented extensions switched by environment variables (read-only in the BCP). */
const ENV_EXT_DEFS: { label: string; rfc: string; env: string }[] = [
  { label: 'SMTPUTF8',            rfc: 'RFC 6531', env: 'SMTP_EXT_SMTPUTF8' },
  { label: 'DSN',                 rfc: 'RFC 3461', env: 'SMTP_EXT_DSN' },
  { label: 'CHUNKING, BINARYMIME', rfc: 'RFC 3030', env: 'SMTP_EXT_CHUNKING' },
];

const RISK_BADGE: Record<Risk, string> = {
  safe:     'bg-success-bg text-success-fg',
  caution:  'bg-warning-bg text-warning-fg',
  advanced: 'bg-info-bg text-info-fg',
};
const RISK_LABEL: Record<Risk, string> = {
  safe: 'Standard', caution: 'Vorsicht', advanced: 'Erweitert',
};

// ═════════════════════════════════════════════════════════════════════════════
// EsmtpSection
// ═════════════════════════════════════════════════════════════════════════════

function EsmtpSection({ s, onSave, pending }: { s: SmtpSettings; onSave: (d: Partial<SmtpSettings>) => void; pending: boolean }) {
  const [vals, setVals] = useState<Partial<SmtpSettings>>({});

  function get(key: keyof SmtpSettings): boolean {
    return (key in vals ? vals[key] : s[key]) as boolean;
  }
  function set(key: keyof SmtpSettings, v: boolean) {
    setVals(prev => ({ ...prev, [key]: v }));
  }

  // Pending changes = toggles that differ from the saved value (0 after the refetch)
  const changed = (Object.keys(vals) as (keyof SmtpSettings)[]).filter((k) => vals[k] !== s[k]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-fg">ESMTP-Erweiterungen</h2>
          <p className="text-xs text-fg-subtle mt-0.5">
            Steuert welche EHLO-Capabilities der SMTP-Server ankündigt und akzeptiert
          </p>
        </div>
        <div className="flex items-center gap-3">
          {changed.length > 0 && (
            <span className="text-xs text-warning-fg">{changed.length} Änderung{changed.length > 1 ? 'en' : ''}</span>
          )}
          <SaveBtn onClick={() => onSave(vals)} pending={pending} />
        </div>
      </div>

      <div className="flex gap-3 text-xs flex-wrap">
        {(['safe', 'caution', 'advanced'] as Risk[]).map(r => (
          <span key={r} className={`px-2 py-0.5 rounded-full font-medium ${RISK_BADGE[r]}`}>
            {RISK_LABEL[r]}
          </span>
        ))}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-surface-2 border-b border-line">
            <tr>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-subtle">Erweiterung</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-subtle hidden lg:table-cell">Beschreibung</th>
              <th className="text-center px-4 py-2.5 text-xs font-semibold text-fg-subtle">Typ</th>
              <th className="text-center px-4 py-2.5 text-xs font-semibold text-fg-subtle">Aktiv</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {EXT_DEFS.map(ext => {
              const active = get(ext.key);
              const modified = ext.key in vals && vals[ext.key] !== s[ext.key];
              return (
                <tr key={ext.key} className={`hover:bg-surface-2 transition-colors ${modified ? 'bg-accent/5' : ''}`}>
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-xs font-semibold text-fg">{ext.label}</span>
                    {ext.warnOff && !active && (
                      <p className="text-[10px] text-warning-fg mt-0.5 flex items-center gap-0.5">
                        <Info size={9} /> {ext.warnOff}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-fg-subtle hidden lg:table-cell max-w-xs">{ext.desc}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${RISK_BADGE[ext.risk]}`}>
                      {RISK_LABEL[ext.risk]}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <Toggle active={active} onToggle={() => set(ext.key, !active)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="bg-info-bg border border-info-line rounded-lg px-4 py-3 text-xs text-info-fg flex items-start gap-2">
        <Info size={13} className="shrink-0 mt-0.5" />
        <span>
          Änderungen gelten sofort für neue SMTP-Verbindungen (kein Neustart nötig).
          Deaktivierte Erweiterungen erscheinen nicht mehr in der EHLO-Antwort.
        </span>
      </div>

      <div className="bg-surface-2 border border-line rounded-lg px-4 py-3 text-xs text-fg-muted flex items-start gap-2">
        <Info size={13} className="shrink-0 mt-0.5" />
        <span>
          Implementiert und standardmäßig aktiv, geschaltet über Umgebungsvariablen (nicht in der BCP):{' '}
          {ENV_EXT_DEFS.map((e, i) => (
            <span key={e.env}>
              {i > 0 && ', '}
              <span className="font-mono font-semibold text-fg">{e.label}</span> (<code className="font-mono">{e.env}=false</code> schaltet ab)
            </span>
          ))}.
        </span>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// DeliverySection
// ═════════════════════════════════════════════════════════════════════════════

function DeliverySection({ s, onSave, pending }: { s: SmtpSettings; onSave: (d: Partial<SmtpSettings>) => void; pending: boolean }) {
  const [enabled, setEnabled] = useState(s.localDeliveryEnabled);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-fg">Lokale Zustellung</h2>
          <p className="text-xs text-fg-subtle mt-0.5">Steuert ob der Server eingehende Nachrichten für lokale Postfächer annimmt</p>
        </div>
        <SaveBtn onClick={() => onSave({ localDeliveryEnabled: enabled })} pending={pending} />
      </div>

      <div className="card p-5 space-y-0">
        <ToggleRow
          label="Lokale Zustellung aktiviert"
          desc="E-Mails an lokal konfigurierte Domains und Postfächer werden angenommen und zugestellt"
          value={enabled}
          onChange={setEnabled}
          warn="Ohne lokale Zustellung werden keine eingehenden Nachrichten angenommen"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className={`card p-4 border-2 transition-colors ${enabled ? 'border-success-line bg-success-bg/30' : 'border-line'}`}>
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle size={15} className={enabled ? 'text-success-fg' : 'text-fg-subtle'} />
            <span className="text-sm font-semibold text-fg">Aktiviert</span>
          </div>
          <ul className="space-y-1 text-xs text-fg-subtle">
            <li>• Empfänger werden gegen lokale Postfächer geprüft</li>
            <li>• Shared Mailboxes erreichbar</li>
          </ul>
        </div>
        <div className={`card p-4 border-2 transition-colors ${!enabled ? 'border-warning-line bg-warning-bg/30' : 'border-line'}`}>
          <div className="flex items-center gap-2 mb-2">
            <Info size={15} className={!enabled ? 'text-warning-fg' : 'text-fg-subtle'} />
            <span className="text-sm font-semibold text-fg">Deaktiviert</span>
          </div>
          <ul className="space-y-1 text-xs text-fg-subtle">
            <li>• Port 25 lehnt alle Empfänger ab (RCPT TO)</li>
            <li>• Versand authentifizierter Benutzer (465/587) bleibt möglich</li>
            <li>• Nützlich für reine Outbound-Server</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// BannerSection
// ═════════════════════════════════════════════════════════════════════════════

function BannerSection({ s, onSave, pending }: { s: SmtpSettings; onSave: (d: Partial<SmtpSettings>) => void; pending: boolean }) {
  const [override, setOverride] = useState(s.bannerOverride);
  const [text, setText]         = useState(s.bannerText);

  // Host name of this BCP as a stand-in for the server host name (ServerSettings.publicHostname)
  const host = window.location.hostname;
  const defaultBanner = smtpGreetingPreview(host, false, '');
  const preview = smtpGreetingPreview(host, override, text);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-fg">SMTP-Banner</h2>
          <p className="text-xs text-fg-subtle mt-0.5">Der Begrüßungstext den der SMTP-Server bei jeder Verbindung sendet (220-Response)</p>
        </div>
        <SaveBtn onClick={() => onSave({ bannerOverride: override, bannerText: text })} pending={pending} />
      </div>

      <div className="card p-5 space-y-0">
        <ToggleRow
          label="Standard-Banner überschreiben"
          desc="Benutzerdefinierten Begrüßungstext anstelle des Standard-Banners verwenden"
          value={override}
          onChange={setOverride}
        />
      </div>

      <div className="card p-5 space-y-4">
        <div>
          <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide mb-2">
            {override ? 'Benutzerdefinierter Banner' : 'Standard-Banner (aktiv)'}
          </p>
          {override ? (
            <textarea
              value={text}
              onChange={e => setText(e.target.value.slice(0, 255))}
              rows={2}
              placeholder="z.B. mail.example.com ESMTP"
              className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg resize-none"
            />
          ) : (
            <div className="bg-surface-2 border border-line rounded-lg px-3 py-2 font-mono text-sm text-fg-muted">
              {defaultBanner}
            </div>
          )}
          <p className="text-xs text-fg-subtle mt-1">
            {override ? `${text.length}/255 Zeichen — beginnt der Text nicht mit einem Hostnamen, wird der Server-Hostname vorangestellt` : 'Hostname + "ESMTP CoreMail"'}
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide mb-2">Vorschau — SMTP-Verbindung</p>
          <div className="bg-surface-2 border border-line rounded-lg p-4 font-mono text-xs space-y-1">
            <p className="text-fg-subtle">{'# telnet mail.example.com 25'}</p>
            <p className="text-success-fg">
              {'220 '}
              <span className="text-fg">{preview}</span>
            </p>
            <p className="text-fg-subtle">{'EHLO client.example.com'}</p>
            <p className="text-success-fg">{'250-mail.example.com'}</p>
            <p className="text-success-fg">{'250-STARTTLS'}</p>
            <p className="text-success-fg">{'250-AUTH PLAIN LOGIN'}</p>
            <p className="text-success-fg">{'250 SIZE 26214400'}</p>
          </div>
        </div>

        <div className="bg-info-bg border border-info-line rounded-lg px-3 py-2 text-xs text-info-fg flex items-start gap-2">
          <Info size={12} className="shrink-0 mt-0.5" />
          <span>
            Der Banner sollte keine detaillierten Software-Versionsinformationen enthalten (Security through obscurity).
            Der SMTP-Standard verlangt, dass der Hostname im Banner erscheint.
          </span>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// GreylistingSection
// ═════════════════════════════════════════════════════════════════════════════

function GreylistingSection({ s, onSave, pending }: { s: SmtpSettings; onSave: (d: Partial<SmtpSettings>) => void; pending: boolean }) {
  const [enabled,   setEnabled]   = useState(s.greylistingEnabled);
  const [wait,      setWait]      = useState(s.greylistWaitSec);
  const [ttl,       setTtl]       = useState(s.greylistTtlHours);
  const [whitelist, setWhitelist] = useState<string[]>(s.greylistWhitelist);
  const [newEntry,  setNewEntry]  = useState('');

  function addEntry() {
    const e = newEntry.trim();
    if (!e || whitelist.includes(e)) { setNewEntry(''); return; }
    setWhitelist(prev => [...prev, e]);
    setNewEntry('');
  }

  const waitMin = Math.round(wait / 60);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-fg">Greylisting</h2>
          <p className="text-xs text-fg-subtle mt-0.5">Temporäres Abweisen unbekannter Absender beim ersten Verbindungsversuch</p>
        </div>
        <SaveBtn onClick={() => onSave({ greylistingEnabled: enabled, greylistWaitSec: wait, greylistTtlHours: ttl, greylistWhitelist: whitelist })} pending={pending} />
      </div>

      <div className="card p-5 space-y-0">
        <ToggleRow
          label="Greylisting aktiviert"
          desc="Erstverbindungen werden mit SMTP 451 temporär abgelehnt — legitime Server versuchen es erneut"
          value={enabled}
          onChange={setEnabled}
        />
        <NumInput label="Wartezeit" desc="Mindestwartezeit bevor ein Wiederholungsversuch akzeptiert wird"
          value={wait} onChange={setWait} min={60} max={3600} unit="Sek" />
        <NumInput label="Whitelist-TTL" desc="Wie lange ein bekanntes Triplet (IP/Absender/Empfänger) in der Whitelist verbleibt"
          value={ttl} onChange={setTtl} min={1} max={168} unit="Std" />
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Wartezeit', value: `${waitMin} Min`, sub: `${wait} Sek` },
          { label: 'Whitelist-TTL', value: `${ttl} Std`, sub: 'nach erstem Durchgang' },
          { label: 'Protokoll', value: 'SMTP 451', sub: 'Temp. Fehler' },
        ].map(c => (
          <div key={c.label} className="card p-3 text-center">
            <p className="text-lg font-bold text-fg">{c.value}</p>
            <p className="text-xs text-fg-subtle">{c.label}</p>
            <p className="text-[10px] text-fg-subtle mt-0.5">{c.sub}</p>
          </div>
        ))}
      </div>

      {/* Flow illustration */}
      <div className="card p-4 space-y-3">
        <p className="text-sm font-semibold text-fg-muted">Ablauf</p>
        <div className="flex items-start gap-3">
          {[
            { step: '1', label: 'Erstversuch', color: 'bg-danger-bg text-danger-fg', desc: `SMTP-Server antwortet: "451 4.7.1 Greylisted — try again in ${waitMin} min"` },
            { step: '2', label: `Nach ${waitMin} Min`, color: 'bg-warning-bg text-warning-fg', desc: 'Legitimer Mailserver wiederholt den Versuch automatisch' },
            { step: '3', label: 'Akzeptiert', color: 'bg-success-bg text-success-fg', desc: `Triplet wird ${ttl}h whitegelistet — alle weiteren Versuche sofort akzeptiert` },
          ].map((item, i) => (
            <div key={i} className="flex-1 flex flex-col items-center text-center">
              <div className={`w-8 h-8 rounded-full ${item.color} flex items-center justify-center font-bold text-sm mb-1`}>
                {item.step}
              </div>
              <p className="text-xs font-semibold text-fg-muted mb-1">{item.label}</p>
              <p className="text-[10px] text-fg-subtle leading-relaxed">{item.desc}</p>
              {i < 2 && (
                <div className="absolute right-0 top-3 text-fg-subtle">→</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Whitelist */}
      <div className="card p-4 space-y-3">
        <p className="text-sm font-semibold text-fg-muted">
          Greylisting-Whitelist
          <span className="text-xs font-normal text-fg-subtle ml-2">IPs / CIDR / Hostnamen die nie gegreylistet werden</span>
        </p>
        {whitelist.length === 0 && (
          <p className="text-xs text-fg-subtle italic">Keine Einträge — alle unbekannten Absender werden gegreylistet</p>
        )}
        <div className="space-y-1.5">
          {whitelist.map(e => (
            <div key={e} className="flex items-center justify-between bg-surface-2 rounded px-3 py-1.5">
              <span className="text-sm font-mono text-fg-muted">{e}</span>
              <button aria-label={`${e} entfernen`} onClick={() => setWhitelist(prev => prev.filter(x => x !== e))}
                className="text-fg-subtle hover:text-danger-fg transition-colors">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={newEntry} onChange={e => setNewEntry(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addEntry()}
            placeholder="z.B. 192.168.1.0/24 oder mx.google.com"
            className="flex-1 border border-line-strong rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg"
          />
          <button onClick={addEntry} className="btn-secondary text-sm gap-1">
            <Plus size={13} /> Hinzufügen
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-line">
          <p className="w-full text-xs text-fg-subtle mb-0.5">Schnell hinzufügen:</p>
          {['127.0.0.1','::1','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'].filter(e => !whitelist.includes(e)).map(e => (
            <button key={e} onClick={() => setWhitelist(prev => [...prev, e])}
              className="text-xs bg-surface-2 hover:bg-surface-3 text-fg-muted px-2 py-0.5 rounded font-mono transition-colors">
              + {e}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// OutgoingSection — outgoing delivery: direct MX or smarthost
// ═════════════════════════════════════════════════════════════════════════════

function OutgoingSection({ s, onSave, pending }: { s: SmtpSettings; onSave: (d: Partial<SmtpSettings>) => void; pending: boolean }) {
  const [mode, setMode]               = useState<'mx' | 'smarthost'>(s.outboundMode ?? 'mx');
  const [host, setHost]               = useState(s.smarthostHost ?? '');
  const [port, setPort]               = useState(s.smarthostPort ?? 587);
  const [tls, setTls]                 = useState(s.smarthostTls ?? true);
  const [implicitTls, setImplicitTls] = useState(s.smarthostImplicitTls ?? false);
  const [username, setUsername]       = useState(s.smarthostUsername ?? '');
  const [password, setPassword]       = useState('');  // never prefilled (security)

  const [testStatus, setTestStatus]   = useState<'idle' | 'testing' | 'ok' | 'err'>('idle');
  const [testMsg, setTestMsg]         = useState('');

  // Implicit TLS → disable STARTTLS (mutually exclusive)
  function handleImplicitTls(v: boolean) {
    setImplicitTls(v);
    if (v) setTls(false);
  }
  function handleStarttls(v: boolean) {
    setTls(v);
    if (v) setImplicitTls(false);
  }

  // Port suggestions depending on TLS mode
  const PORT_PRESETS = [
    { label: '25 – SMTP', port: 25 },
    { label: '587 – Submission', port: 587 },
    { label: '465 – SMTPS', port: 465 },
    { label: '2525 – Alt', port: 2525 },
  ];

  async function testConnection() {
    setTestStatus('testing');
    setTestMsg('');
    try {
      // API client: in-memory access token in the Authorization header, refresh + error handling
      const data = await api.post<{ ok: boolean; message: string }>('/admin/smtp-config/test-smarthost', {
        host, port, tls, implicitTls, username, password: password || undefined,
      });
      setTestStatus(data.ok ? 'ok' : 'err');
      setTestMsg(data.message);
    } catch (err) {
      setTestStatus('err');
      setTestMsg(err instanceof Error && err.message ? err.message : 'Verbindungstest fehlgeschlagen');
    }
  }

  function handleSave() {
    if (mode === 'smarthost' && !host.trim()) { toast.error('Bitte einen Smarthost-Server angeben'); return; }
    const payload: Partial<SmtpSettings> = {
      outboundMode:          mode,
      smarthostHost:         host,
      smarthostPort:         port,
      smarthostTls:          tls,
      smarthostImplicitTls:  implicitTls,
      smarthostUsername:     username,
    };
    if (password) payload.smarthostPassword = password;
    onSave(payload);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-fg">Ausgehende Zustellung</h2>
          <p className="text-xs text-fg-subtle mt-0.5">
            Wie CoreMail ausgehende E-Mails an externe Empfänger zustellt
          </p>
        </div>
        <SaveBtn onClick={handleSave} pending={pending} />
      </div>

      {/* Mode Selector */}
      <div className="grid grid-cols-2 gap-3">
        {([
          {
            value: 'mx' as const,
            label: 'Direkte MX-Zustellung',
            desc: 'CoreMail fragt den DNS-MX-Record des Empfängers ab und stellt direkt an dessen Mailserver zu. Standard für öffentliche Mailserver.',
            icon: '🌐',
          },
          {
            value: 'smarthost' as const,
            label: 'Smarthost / Relay',
            desc: 'Alle ausgehenden Mails werden über einen zentralen Relay-Server gesendet. Ideal wenn der ISP Port 25 sperrt oder ein externer SMTP-Dienst (Mailjet, Sendgrid, …) genutzt wird.',
            icon: '🔀',
          },
        ] as const).map(opt => (
          <button
            key={opt.value}
            onClick={() => setMode(opt.value)}
            className={`text-left p-4 rounded-lg border-2 transition-all ${
              mode === opt.value
                ? 'border-accent-fg bg-accent/5'
                : 'border-line hover:border-line-strong bg-surface'
            }`}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xl">{opt.icon}</span>
              <span className="font-semibold text-sm text-fg">{opt.label}</span>
              {mode === opt.value && (
                <CheckCircle size={14} className="ml-auto text-accent-fg" />
              )}
            </div>
            <p className="text-xs text-fg-subtle leading-relaxed">{opt.desc}</p>
          </button>
        ))}
      </div>

      {/* MX Info */}
      {mode === 'mx' && (
        <div className="bg-success-bg border border-success-line rounded-lg px-4 py-3 text-xs text-success-fg flex items-start gap-2">
          <CheckCircle size={13} className="shrink-0 mt-0.5 text-success-fg" />
          <div>
            <span className="font-semibold">Direkte MX-Zustellung aktiv</span>
            <p className="mt-0.5 text-success-fg">
              CoreMail stellt Mails direkt an den Ziel-Mailserver zu. Stelle sicher, dass Port 25
              ausgehend von deinem Server nicht geblockt ist und ein gültiger PTR-/DMARC-Record gesetzt ist.
            </p>
          </div>
        </div>
      )}

      {/* Smarthost Settings */}
      {mode === 'smarthost' && (
        <div className="space-y-4">
          {/* Host + Port */}
          <div className="card p-5 space-y-4">
            <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide border-b border-line pb-2">Verbindung</p>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-fg-muted mb-1">Smarthost / Relay-Server</label>
                <input
                  value={host} onChange={e => setHost(e.target.value)}
                  placeholder="z.B. smtp.sendgrid.net"
                  className="w-full border border-line-strong rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-fg-muted mb-1">Port</label>
                <input
                  type="number" min={1} max={65535} value={port}
                  onChange={e => setPort(parseInt(e.target.value, 10) || 587)}
                  className="w-full border border-line-strong rounded px-3 py-1.5 text-sm text-right font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg"
                />
              </div>
            </div>

            {/* Port quick select */}
            <div className="flex flex-wrap gap-1.5">
              <span className="text-xs text-fg-subtle self-center">Schnell:</span>
              {PORT_PRESETS.map(p => (
                <button
                  key={p.port}
                  onClick={() => {
                    setPort(p.port);
                    if (p.port === 465) { setImplicitTls(true); setTls(false); }
                    else if (p.port === 587) { setTls(true); setImplicitTls(false); }
                    else { setTls(false); setImplicitTls(false); }
                  }}
                  className={`text-xs px-2 py-0.5 rounded font-mono border transition-colors ${
                    port === p.port
                      ? 'bg-accent text-white border-accent-fg'
                      : 'bg-surface-2 text-fg-muted border-line hover:bg-surface-2'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* TLS */}
          <div className="card p-5 space-y-0">
            <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide pb-3 border-b border-line">TLS-Verschlüsselung</p>
            <ToggleRow
              label="STARTTLS (opportunistisch)"
              desc="Verbindung beginnt als Plaintext und wird per STARTTLS auf TLS aufgewertet — Standard für Port 587"
              value={tls}
              onChange={handleStarttls}
            />
            <ToggleRow
              label="Implizites TLS (SMTPS)"
              desc="Verbindung startet sofort als TLS — Standard für Port 465; deaktiviert STARTTLS"
              value={implicitTls}
              onChange={handleImplicitTls}
            />
          </div>

          {/* Auth */}
          <div className="card p-5 space-y-4">
            <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide border-b border-line pb-2">Authentifizierung (optional)</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-fg-muted mb-1">Benutzername</label>
                <input
                  value={username} onChange={e => setUsername(e.target.value)}
                  placeholder="z.B. apikey oder user@domain.de"
                  autoComplete="off"
                  className="w-full border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-fg-muted mb-1">
                  Passwort
                  {s.smarthostPassword === '••••••••' && (
                    <span className="ml-1.5 text-fg-subtle font-normal">(gespeichert — leer lassen um beizubehalten)</span>
                  )}
                </label>
                <input
                  type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder={s.smarthostPassword === '••••••••' ? '••••••••' : 'Kein Passwort gesetzt'}
                  autoComplete="new-password"
                  className="w-full border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg"
                />
              </div>
            </div>
          </div>

          {/* Test Connection */}
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <button
                onClick={testConnection}
                disabled={!host || testStatus === 'testing'}
                className="btn-secondary text-sm gap-2 disabled:opacity-50"
              >
                {testStatus === 'testing'
                  ? <><Loader2 size={13} className="animate-spin" /> Verbinde…</>
                  : <><SendHorizonal size={13} /> Verbindung testen</>
                }
              </button>
              {testStatus === 'ok' && (
                <span className="flex items-center gap-1.5 text-sm text-success-fg">
                  <CheckCircle size={14} /> {testMsg}
                </span>
              )}
              {testStatus === 'err' && (
                <span className="flex items-center gap-1.5 text-sm text-danger-fg">
                  <XCircle size={14} /> {testMsg}
                </span>
              )}
            </div>
            <p className="text-xs text-fg-subtle mt-2">
              Testet die SMTP-Verbindung ohne E-Mails zu senden. Verwendete Einstellungen: aktueller Formularinhalt (noch nicht gespeichert).
            </p>
          </div>

          {/* Provider Presets */}
          <div className="card p-4">
            <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide mb-3">Bekannte Anbieter</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[
                { name: 'SendGrid',    host: 'smtp.sendgrid.net',         port: 587, tls: true,  implTls: false },
                { name: 'Mailjet',     host: 'in-v3.mailjet.com',         port: 587, tls: true,  implTls: false },
                { name: 'Mailgun',     host: 'smtp.mailgun.org',          port: 587, tls: true,  implTls: false },
                { name: 'Postmark',    host: 'smtp.postmarkapp.com',      port: 587, tls: true,  implTls: false },
                { name: 'Amazon SES',  host: 'email-smtp.eu-west-1.amazonaws.com', port: 587, tls: true, implTls: false },
                { name: 'Gmail',       host: 'smtp.gmail.com',            port: 465, tls: false, implTls: true  },
                { name: 'Office 365',  host: 'smtp.office365.com',        port: 587, tls: true,  implTls: false },
                { name: 'IONOS',       host: 'smtp.ionos.de',             port: 587, tls: true,  implTls: false },
                { name: 'Strato',      host: 'smtp.strato.de',            port: 465, tls: false, implTls: true  },
              ].map(p => (
                <button
                  key={p.name}
                  onClick={() => { setHost(p.host); setPort(p.port); setTls(p.tls); setImplicitTls(p.implTls); }}
                  className="text-left px-3 py-2 rounded border border-line hover:border-accent-fg hover:bg-accent/5 transition-colors"
                >
                  <p className="text-xs font-semibold text-fg-muted">{p.name}</p>
                  <p className="text-[10px] text-fg-subtle font-mono">{p.host}:{p.port}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ConnectionSection
// ═════════════════════════════════════════════════════════════════════════════

function ConnectionSection({ s, onSave, pending }: { s: SmtpSettings; onSave: (d: Partial<SmtpSettings>) => void; pending: boolean }) {
  const [vals, setVals] = useState({
    maxConnections:       s.maxConnections,
    maxConnectionsPerIp:  s.maxConnectionsPerIp,
    maxMessageSizeMb:     s.maxMessageSizeMb,
    maxRecipients:        s.maxRecipients,
    connectionTimeoutSec: s.connectionTimeoutSec,
    greetingDelaySec:     s.greetingDelaySec,
    maxAuthFailures:      s.maxAuthFailures,
  });

  function set<K extends keyof typeof vals>(k: K, v: number) {
    setVals(prev => ({ ...prev, [k]: v }));
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-fg">Verbindungseinstellungen</h2>
          <p className="text-xs text-fg-subtle mt-0.5">Limits und Timeouts für SMTP-Verbindungen und Nachrichten</p>
        </div>
        <SaveBtn onClick={() => onSave(vals)} pending={pending} />
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Max. Verbindungen', value: vals.maxConnections },
          { label: 'Max. je IP', value: vals.maxConnectionsPerIp },
          { label: 'Max. Empfänger', value: vals.maxRecipients },
        ].map(c => (
          <div key={c.label} className="card p-3 text-center">
            <p className="text-xl font-bold text-fg">{c.value.toLocaleString()}</p>
            <p className="text-xs text-fg-subtle">{c.label}</p>
          </div>
        ))}
      </div>

      {/* Connection limits */}
      <div className="card p-5 space-y-0">
        <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide pb-3 border-b border-line">Verbindungslimits</p>
        <NumInput label="Maximale gleichzeitige Verbindungen"
          desc="Gesamtanzahl aktiver SMTP-Verbindungen (alle IPs)"
          value={vals.maxConnections} onChange={v => set('maxConnections', v)} min={1} max={10000} unit="Verb." />
        <NumInput label="Maximale Verbindungen pro IP"
          desc="Verhindert DDoS/Spam von einzelnen IP-Adressen (private und lokale Netze sind ausgenommen)"
          value={vals.maxConnectionsPerIp} onChange={v => set('maxConnectionsPerIp', v)} min={1} max={1000} unit="Verb." />
        <NumInput label="Maximale Empfänger pro Nachricht"
          desc="Anzahl RCPT TO-Befehle pro Mail-Transaktion"
          value={vals.maxRecipients} onChange={v => set('maxRecipients', v)} min={1} max={10000} unit="Empf." />
        <NumInput label="Maximale Auth-Fehlversuche"
          desc="Verbindung wird nach dieser Anzahl fehlgeschlagener AUTH-Versuche getrennt"
          value={vals.maxAuthFailures} onChange={v => set('maxAuthFailures', v)} min={1} max={100} />
      </div>

      {/* Message size */}
      <div className="card p-5 space-y-0">
        <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide pb-3 border-b border-line">Nachrichtengröße</p>
        <NumInput label="Maximale Nachrichtengröße"
          desc="Nachrichten größer als dieser Wert werden mit 552 abgelehnt"
          value={vals.maxMessageSizeMb} onChange={v => set('maxMessageSizeMb', v)} min={1} max={500} unit="MB" />
      </div>

      {/* Timeouts */}
      <div className="card p-5 space-y-0">
        <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide pb-3 border-b border-line">Timeouts & Verzögerungen</p>
        <NumInput label="Verbindungs-Timeout"
          desc="Inaktive Verbindungen werden nach dieser Zeit getrennt (mindestens 300 s)"
          value={vals.connectionTimeoutSec} onChange={v => set('connectionTimeoutSec', v)} min={30} max={3600} unit="Sek" />
        <NumInput label="Greeting Delay"
          desc="Verzögert die 220-Antwort auf Port 25 — Clients, die vorher senden, werden abgewiesen (hilft gegen Spam-Bots)"
          value={vals.greetingDelaySec} onChange={v => set('greetingDelaySec', v)} min={0} max={30} unit="Sek" />
      </div>

      <div className="bg-info-bg border border-info-line rounded-lg px-4 py-3 text-xs text-info-fg flex items-start gap-2">
        <Info size={13} className="shrink-0 mt-0.5" />
        <span>
          Der SMTP-Standard schreibt Mindest-Timeouts vor: EHLO/HELO 5 Min, MAIL 5 Min, DATA-Initiierung 2 Min, DATA-Block 3 Min.
          Der Verbindungs-Timeout sollte mindestens 300 Sek. betragen.
        </span>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// DnsSection — DNS records for mail operation
// ═════════════════════════════════════════════════════════════════════════════

interface DomainItem { id: string; name: string; primary: boolean; dkimSelector: string }
interface DomainsResp { domains: DomainItem[] }

interface DnsRecord {
  type:     string;
  name:     string;
  expected: string;
  ok:       boolean;
  found:    string | null;
  warning?: string;
}

interface DnsCheckResult {
  domain:   string;
  hostname: string;
  records: {
    mx:           DnsRecord;
    spf:          DnsRecord;
    dkim:         DnsRecord;
    dmarc:        DnsRecord;
    autodiscover: DnsRecord;
    ptr:          DnsRecord;
  };
}

// ── CopyBtn ───────────────────────────────────────────────────────────────────
function CopyBtn({ text, size = 13 }: { text: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    copyToClipboard(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => toast.error('Kopieren fehlgeschlagen'));
  }, [text]);
  return (
    <button aria-label="Kopieren"
      onClick={handleCopy}
      title="Kopieren"
      className="shrink-0 p-1 rounded text-fg-subtle hover:text-accent-fg hover:bg-accent/10 transition-colors"
    >
      {copied
        ? <Check size={size} className="text-success-fg" />
        : <Copy size={size} />}
    </button>
  );
}

// ── StatusDot — green = ok, yellow = warning (exists but differs), red = missing
function StatusDot({ ok, checking, warning }: { ok: boolean; checking: boolean; warning?: boolean }) {
  if (checking) return <Loader2 size={14} className="animate-spin text-fg-subtle shrink-0" />;
  const color = ok ? 'bg-success' : warning ? 'bg-warning' : 'bg-danger';
  return <span className={`inline-block w-3 h-3 rounded-full shrink-0 mt-0.5 ${color}`} />;
}

// ── DnsRow — one row in the DNS table ─────────────────────────────────────────
interface DnsRowProps {
  label:       string;
  description: string;
  record:      DnsRecord;
  checking:    boolean;
  isLast?:     boolean;
}
function DnsRow({ label, description, record, checking, isLast }: DnsRowProps) {
  return (
    <div className={`grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 py-4 ${isLast ? '' : 'border-b border-line'}`}>
      {/* Status dot */}
      <div className="flex items-start pt-0.5">
        <StatusDot ok={record.ok} checking={checking} warning={!!record.warning} />
      </div>

      <div className="space-y-2 min-w-0">
        {/* Label row */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-fg">{label}</span>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-surface-2 text-fg-subtle font-mono border border-line">
            {record.type}
          </span>
          {!checking && (
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
              record.ok        ? 'bg-success-bg  text-success-fg'
              : record.warning ? 'bg-warning-bg text-warning-fg'
              :                  'bg-danger-bg    text-danger-fg'
            }`}>
              {record.ok ? '● Gesetzt' : record.warning ? '⚠ Warnung' : '○ Nicht gefunden'}
            </span>
          )}
        </div>

        <p className="text-xs text-fg-subtle leading-relaxed">{description}</p>

        {/* Special warning (e.g. multiple SPF records) */}
        {!checking && record.warning && (
          <div className="flex items-start gap-1.5 bg-danger-bg border border-danger-line rounded px-2 py-1.5">
            <AlertCircle size={11} className="text-danger-fg shrink-0 mt-0.5" />
            <span className="text-[11px] text-danger-fg font-medium">{record.warning}</span>
          </div>
        )}

        {/* DNS name + copy */}
        <div className="flex items-center gap-1 bg-surface-2 rounded border border-line px-2 py-1.5">
          <span className="text-[10px] text-fg-subtle font-medium mr-1 shrink-0">Name</span>
          <code className="flex-1 text-xs text-fg-muted font-mono break-all">{record.name}</code>
          <CopyBtn text={record.name} />
        </div>

        {/* Expected value + copy */}
        <div className="flex items-start gap-1 bg-surface-2 rounded border border-line px-2 py-1.5">
          <span className="text-[10px] text-fg-subtle font-medium mr-1 mt-0.5 shrink-0">Wert</span>
          <code className="flex-1 text-xs text-fg font-mono break-all leading-relaxed">{record.expected}</code>
          <CopyBtn text={record.expected} />
        </div>

        {/* Currently found in DNS */}
        {!checking && record.ok && record.found && (
          <div className="flex items-start gap-1.5 bg-success-bg border border-success-line rounded px-2 py-1.5">
            <CheckCircle size={11} className="text-success-fg shrink-0 mt-0.5" />
            <code className="text-[11px] text-success-fg font-mono break-all leading-relaxed">{record.found}</code>
          </div>
        )}
        {!checking && !record.ok && record.found && !record.warning && (
          <div className="flex items-start gap-1.5 bg-warning-bg border border-warning-line rounded px-2 py-1.5">
            <AlertCircle size={11} className="text-warning-fg shrink-0 mt-0.5" />
            <span className="text-[11px] text-warning-fg">
              Gefunden, aber abweichend: <code className="font-mono">{record.found}</code>
            </span>
          </div>
        )}
        {!checking && !record.ok && record.found && record.warning && (
          <div className="flex items-start gap-1.5 bg-danger-bg border border-danger-line rounded px-2 py-1.5">
            <AlertCircle size={11} className="text-danger-fg shrink-0 mt-0.5" />
            <code className="text-[11px] text-danger-fg font-mono break-all leading-relaxed">{record.found}</code>
          </div>
        )}
        {!checking && !record.ok && !record.found && (
          <div className="flex items-center gap-1.5 bg-warning-bg border border-warning-line rounded px-2 py-1.5">
            <AlertCircle size={11} className="text-warning-fg shrink-0" />
            <span className="text-[11px] text-warning-fg">Kein Eintrag gefunden — beim DNS-Anbieter eintragen</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── PTR row ───────────────────────────────────────────────────────────────────
function PtrRow({ record, hostname, checking }: { record?: DnsRecord; hostname: string; checking: boolean }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 py-4">
      <div className="flex items-start pt-0.5">
        {checking
          ? <Loader2 size={14} className="animate-spin text-fg-subtle shrink-0" />
          : record
            ? <span className={`inline-block w-3 h-3 rounded-full shrink-0 mt-0.5 ${record.ok ? 'bg-success' : 'bg-warning'}`} />
            : <span className="inline-block w-3 h-3 rounded-full shrink-0 mt-0.5 bg-info" />
        }
      </div>
      <div className="space-y-2 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-fg">Reverse DNS (PTR / FCrDNS)</span>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-surface-2 text-fg-subtle font-mono border border-line">PTR</span>
          {!checking && record && (
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
              record.ok ? 'bg-success-bg text-success-fg' : 'bg-warning-bg text-warning-fg'
            }`}>
              {record.ok ? '● FCrDNS OK' : '○ PTR fehlt / falsch'}
            </span>
          )}
          {!checking && !record && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-info-bg text-info-fg">
              Beim Hosting-Anbieter setzen
            </span>
          )}
        </div>

        <p className="text-xs text-fg-subtle leading-relaxed">
          Forward-confirmed reverse DNS (FCrDNS): Der PTR-Record der Server-IP muss auf{' '}
          <code className="font-mono">{hostname}</code> zeigen — und <code className="font-mono">{hostname}</code>{' '}
          muss per A-Record auf dieselbe IP zurückzeigen. Wird im Server-Panel des Hosters gesetzt.
        </p>

        {!checking && record?.ok && record.found && (
          <div className="flex items-start gap-1.5 bg-success-bg border border-success-line rounded px-2 py-1.5">
            <CheckCircle size={11} className="text-success-fg shrink-0 mt-0.5" />
            <code className="text-[11px] text-success-fg font-mono break-all">{record.found}</code>
          </div>
        )}
        {!checking && record && !record.ok && (
          <div className="flex items-start gap-1.5 bg-warning-bg border border-warning-line rounded px-2 py-1.5">
            <AlertCircle size={11} className="text-warning-fg shrink-0 mt-0.5" />
            <span className="text-[11px] text-warning-fg">
              {record.found
                ? <>PTR vorhanden, stimmt aber nicht überein: <code className="font-mono">{record.found}</code></>
                : 'Kein PTR-Record gefunden — im Server-Panel des Hosting-Anbieters (Contabo, Hetzner …) setzen.'
              }
            </span>
          </div>
        )}

        <div className="flex items-start gap-1 bg-surface-2 rounded border border-line px-2 py-1.5">
          <span className="text-[10px] text-fg-subtle font-medium mr-1 mt-0.5 shrink-0">Soll-Wert</span>
          <code className="flex-1 text-xs text-fg font-mono break-all">{hostname}</code>
          <CopyBtn text={hostname} />
        </div>
      </div>
    </div>
  );
}

// ── DnsSection (main component) ───────────────────────────────────────────────
function DnsSection() {
  const [selectedDomainId, setSelectedDomainId] = useState<string>('');
  const [checkKey, setCheckKey] = useState(0);

  const { data: domainsData } = useQuery({
    queryKey: ['admin-domains-dns'],
    queryFn:  () => api.get<DomainsResp>('/admin/domains?limit=100'),
    select:   d => d.domains,
  });

  const domains           = domainsData ?? [];
  const effectiveDomainId = selectedDomainId || (domains.find(d => d.primary)?.id ?? domains[0]?.id ?? '');
  const selectedDomain    = domains.find(d => d.id === effectiveDomainId);

  const { data: dnsCheck, isFetching: checking } = useQuery({
    queryKey:  ['dns-check', effectiveDomainId, checkKey],
    queryFn:   () => api.get<DnsCheckResult>(`/admin/domains/${effectiveDomainId}/dns-check`),
    enabled:   !!effectiveDomainId,
    staleTime: 0,
    gcTime:    0,
  });

  // 6 visible entries: MX, SPF, DKIM, DMARC, Autodiscover, PTR
  // (A record is returned by the backend but NOT rendered in the UI —
  //  so it must not be included in the counter either, otherwise inconsistency)
  const VISIBLE_DNS_KEYS = ['mx', 'spf', 'dkim', 'dmarc', 'autodiscover', 'ptr'] as const;
  const visibleRecords = dnsCheck
    ? VISIBLE_DNS_KEYS.map(k => dnsCheck.records[k])
    : [];
  const okCount      = visibleRecords.filter(r => r.ok).length;
  const warnCount    = visibleRecords.filter(r => !r.ok && r.warning).length;
  const missingCount = visibleRecords.filter(r => !r.ok && !r.warning).length;
  const total        = VISIBLE_DNS_KEYS.length;
  const allOk        = okCount === total;
  const hasWarn      = warnCount > 0;

  const emptyRecord = (type: string, name: string, expected: string): DnsRecord =>
    ({ type, name, expected, ok: false, found: null });

  const rows: { label: string; description: string; key: keyof DnsCheckResult['records']; fallback: DnsRecord }[] = [
    {
      key:         'mx',
      label:       'MX — Mailrouting',
      description: `Leitet eingehende E-Mails an @${selectedDomain?.name ?? '…'} zu diesem Mailserver weiter`,
      fallback:    emptyRecord('MX',    selectedDomain?.name ?? '', `10 ${dnsCheck?.hostname ?? '…'}`),
    },
    {
      key:         'spf',
      label:       'SPF — Sender Policy Framework',
      description: 'Legt fest welche IPs im Namen der Domain senden dürfen — nur EINEN SPF-Record setzen',
      fallback:    emptyRecord('TXT',   selectedDomain?.name ?? '', 'v=spf1 ip4:<ServerIP> -all'),
    },
    {
      key:         'dkim',
      label:       `DKIM — Signatur (Selektor: ${selectedDomain?.dkimSelector ?? 'mail'})`,
      description: 'Kryptografische Signatur — beweist Absenderauthentizität und verhindert Manipulation',
      fallback:    emptyRecord('TXT',   `${selectedDomain?.dkimSelector ?? 'mail'}._domainkey.${selectedDomain?.name ?? '…'}`, 'v=DKIM1; k=rsa; p=…'),
    },
    {
      key:         'dmarc',
      label:       'DMARC — Richtlinie bei Fehlern',
      description: 'Gibt Empfänger-Servern an wie sie mit Mails umgehen sollen, die SPF/DKIM nicht bestehen',
      fallback:    emptyRecord('TXT',   `_dmarc.${selectedDomain?.name ?? '…'}`, 'v=DMARC1; p=quarantine; rua=mailto:dmarc@…'),
    },
    {
      key:         'autodiscover',
      label:       'Autodiscover — Client-Konfiguration',
      description: 'Ermöglicht Desktop-Mailprogrammen und iOS Mail die automatische Server-Konfiguration per E-Mail-Adresse',
      fallback:    emptyRecord('CNAME', `autodiscover.${selectedDomain?.name ?? '…'}`, dnsCheck?.hostname ?? '…'),
    },
  ];

  return (
    <div className="space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-semibold text-fg">DNS-Einträge</h2>
          <p className="text-xs text-fg-subtle mt-0.5">
            Prüft alle für den Mailserver erforderlichen DNS-Einträge
          </p>
        </div>
        <button
          onClick={() => setCheckKey(k => k + 1)}
          disabled={!effectiveDomainId || checking}
          className="flex items-center gap-1.5 text-sm text-accent-fg border border-accent/30 hover:bg-accent/5 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
        >
          <RefreshCw size={13} className={checking ? 'animate-spin' : ''} />
          Prüfen
        </button>
      </div>

      {/* ── Domain tabs ─────────────────────────────────────────────────── */}
      {domains.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {domains.map(d => (
            <button
              key={d.id}
              onClick={() => { setSelectedDomainId(d.id); setCheckKey(k => k + 1); }}
              className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
                d.id === effectiveDomainId
                  ? 'bg-accent text-white border-accent-fg'
                  : 'bg-surface text-fg-muted border-line hover:border-accent/40'
              }`}
            >
              {d.name}
              {d.primary && <span className="ml-1.5 text-[10px] opacity-70">primär</span>}
            </button>
          ))}
        </div>
      )}

      {domains.length === 0 && (
        <div className="card p-8 text-center text-sm text-fg-subtle">
          Keine Domains — bitte zuerst eine Domain unter <strong>Domains</strong> anlegen.
        </div>
      )}

      {/* ── Status banner ──────────────────────────────────────────────── */}
      {dnsCheck && !checking && (
        <div className={`rounded-lg px-4 py-3 flex items-start gap-3 border ${
          allOk && !hasWarn ? 'bg-success-bg border-success-line' : 'bg-warning-bg border-warning-line'
        }`}>
          <span className={`w-3 h-3 rounded-full shrink-0 mt-0.5 ${allOk && !hasWarn ? 'bg-success' : 'bg-warning'}`} />
          <div className="flex-1 min-w-0">
            <p className={`text-sm font-semibold ${allOk && !hasWarn ? 'text-success-fg' : 'text-warning-fg'}`}>
              {allOk && !hasWarn
                ? `Alle ${total} Einträge für ${dnsCheck.domain} sind korrekt gesetzt ✓`
                : (() => {
                    const parts: string[] = [];
                    if (warnCount > 0)    parts.push(`${warnCount} ${warnCount === 1 ? 'mit Warnung' : 'mit Warnungen'}`);
                    if (missingCount > 0) parts.push(`${missingCount} ${missingCount === 1 ? 'fehlt' : 'fehlen'}`);
                    return `${okCount} von ${total} Einträgen gesetzt${parts.length ? ' — ' + parts.join(', ') : ''}`;
                  })()}
            </p>
            <p className={`text-xs mt-0.5 ${allOk && !hasWarn ? 'text-success-fg' : 'text-warning-fg'}`}>
              Mailserver: <strong className="font-mono">{dnsCheck.hostname}</strong>
            </p>
          </div>
        </div>
      )}

      {/* ── DNS table ───────────────────────────────────────────────────── */}
      {domains.length > 0 && (
        <div className="card divide-y divide-line overflow-hidden">
          <div className="px-4 py-2 bg-surface-2 flex items-center gap-2">
            <Globe size={12} className="text-fg-subtle" />
            <span className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wider">
              {selectedDomain?.name ?? '…'}
            </span>
            {checking && <Loader2 size={11} className="animate-spin text-fg-subtle ml-auto" />}
          </div>

          <div className="px-4">
            {rows.map((row) => (
              <DnsRow
                key={row.key}
                label={row.label}
                description={row.description}
                record={dnsCheck?.records[row.key] ?? row.fallback}
                checking={checking && !dnsCheck}
                isLast={false}
              />
            ))}

            {/* PTR — now with real check result */}
            {(dnsCheck || selectedDomain) && (
              <PtrRow
                record={dnsCheck?.records.ptr}
                hostname={dnsCheck?.hostname ?? selectedDomain?.name ?? '…'}
                checking={checking && !dnsCheck}
              />
            )}
          </div>
        </div>
      )}

      {/* ── Legend ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-5 text-xs text-fg-subtle px-1 flex-wrap">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-success inline-block" /> Gesetzt
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-warning inline-block" /> Warnung (Eintrag existiert, aber Wert weicht ab)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-danger inline-block" /> Nicht gefunden
        </span>
        <span className="text-fg-subtle">· Prüfung über lokalen Resolver (kein Caching)</span>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SmtpConfigPage (root)
// ═════════════════════════════════════════════════════════════════════════════

export function SmtpConfigPage() {
  const [section, setSection] = useState<Section>('esmtp');
  const qc = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ['admin', 'smtp-config', 'settings'],
    queryFn:  () => api.get<SmtpSettings>('/admin/smtp-config/settings'),
  });

  const saveMut = useMutation({
    mutationFn: (data: Partial<SmtpSettings>) =>
      api.put<SmtpSettings>('/admin/smtp-config/settings', data),
    onSuccess: () => {
      toast.success('SMTP-Einstellungen gespeichert');
      qc.invalidateQueries({ queryKey: ['admin', 'smtp-config', 'settings'] });
    },
    onError: (e) => toast.error(errorMessage(e, 'Fehler beim Speichern')),
  });

  return (
    <div className="flex h-full">
      {/* ── Left sub-nav ────────────────────────────────────────────────── */}
      <aside className="w-44 shrink-0 bg-surface-2 border-r border-line flex flex-col h-full">
        <div className="px-3 py-3 border-b border-line">
          <p className="text-[10px] font-bold uppercase tracking-widest text-fg-subtle">SMTP-Konfiguration</p>
        </div>
        <nav className="flex-1 py-2 space-y-0.5">
          {SUB_NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setSection(id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                section === id
                  ? 'bg-surface-3 text-fg border-l-2 border-accent-fg'
                  : 'text-fg-muted hover:bg-surface-3 hover:text-fg'
              }`}>
              <Icon size={13} className="shrink-0" />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* DNS tab needs no SmtpSettings — always renderable */}
        {section === 'dns' && <DnsSection />}
        {/* Geräte-Relay has its own settings row and API */}
        {section === 'devicerelay' && <DeviceRelaySection />}

        {section !== 'dns' && section !== 'devicerelay' && (
          !settings ? (
            <div className="text-sm text-fg-subtle">Lade SMTP-Einstellungen…</div>
          ) : (
            <WriteGuard area="servers">
              {section === 'esmtp'       && <EsmtpSection       s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
              {section === 'delivery'    && <DeliverySection    s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
              {section === 'outgoing'    && <OutgoingSection    s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
              {section === 'banner'      && <BannerSection      s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
              {section === 'greylisting' && <GreylistingSection s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
              {section === 'connection'  && <ConnectionSection  s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
            </WriteGuard>
          )
        )}
      </div>
    </div>
  );
}
