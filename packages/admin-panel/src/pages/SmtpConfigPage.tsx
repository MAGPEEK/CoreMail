import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Terminal, Package, MessageSquare, Clock, ArrowRightLeft,
  Network, Plus, Trash2, CheckCircle, Info, SendHorizonal,
  Loader2, XCircle, Globe, Copy, Check, RefreshCw, AlertCircle,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';
import { copyToClipboard } from '../utils/clipboard.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SmtpSettings {
  extStarttls:          boolean;
  extAuthPlain:         boolean;
  extAuthLogin:         boolean;
  extPipelining:        boolean;
  extSize:              boolean;
  ext8bitmime:          boolean;
  extEnhancedStatus:    boolean;
  // Folgende DB-Felder bleiben aus Backwards-Compat erhalten werden aber im Server
  // hardcoded ignoriert (siehe smtp-server/server.ts), da nicht implementiert:
  //   extAuthCramMd5, extSmtputf8, extDsn, extChunking
  localDeliveryEnabled: boolean;
  bannerOverride:       boolean;
  bannerText:           string;
  relayingEnabled:      boolean;
  relayDomains:         string[];
  relayRequireAuth:     boolean;
  relayTrustedIps:      string[];
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
  // Ausgehende Zustellung
  outboundMode:          'mx' | 'smarthost';
  smarthostHost:         string;
  smarthostPort:         number;
  smarthostTls:          boolean;
  smarthostImplicitTls:  boolean;
  smarthostUsername:     string;
  smarthostPassword:     string;
  outboundFilterEnabled: boolean;
}

// ── Sub-Navigation ────────────────────────────────────────────────────────────

type Section = 'esmtp' | 'delivery' | 'banner' | 'greylisting' | 'relaying' | 'connection' | 'outgoing' | 'dns';

const SUB_NAV: { id: Section; label: string; icon: React.ElementType }[] = [
  { id: 'esmtp',       label: 'ESMTP-Befehle',    icon: Terminal },
  { id: 'delivery',    label: 'Lokale Zustellung', icon: Package },
  { id: 'outgoing',    label: 'Ausgehende Mail',   icon: SendHorizonal },
  { id: 'banner',      label: 'SMTP-Banner',       icon: MessageSquare },
  { id: 'greylisting', label: 'Greylisting',       icon: Clock },
  { id: 'relaying',    label: 'Relaying',          icon: ArrowRightLeft },
  { id: 'connection',  label: 'Verbindung',        icon: Network },
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
    <div className="flex items-start justify-between py-3 border-b border-gray-100 last:border-0">
      <div className="flex-1 pr-6">
        <p className="text-sm font-medium text-gray-800">{label}</p>
        {desc && <p className="text-xs text-gray-400 mt-0.5">{desc}</p>}
        {warn && value === false && (
          <p className="text-xs text-amber-600 mt-0.5 flex items-center gap-1">
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
    <div className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <div>
        <p className="text-sm font-medium text-gray-800">{label}</p>
        {desc && <p className="text-xs text-gray-400 mt-0.5">{desc}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <input
          type="number" min={min} max={max} value={value}
          onChange={e => onChange(parseInt(e.target.value, 10) || min)}
          className="w-24 border border-gray-300 rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-accent"
        />
        {unit && <span className="text-xs text-gray-400 w-10">{unit}</span>}
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
  // Bewusst NICHT als Toggles verfügbar — diese Extensions sind im Server nicht implementiert
  // und würden bei Aktivierung gegen die jeweilige RFC verstoßen (Server lügt über Capability):
  //   CRAM-MD5 (RFC 2195/4954) — handleAuth kennt nur PLAIN+LOGIN, 504 bei CRAM-MD5
  //   SMTPUTF8 (RFC 6531)      — UTF-8 in Envelope-Adressen wird nicht gesondert behandelt
  //   DSN (RFC 3461)           — kein NOTIFY/ORCPT/ENVID/RET-Parsing, kein multipart/report
  //   CHUNKING (RFC 3030)      — BDAT-Command wird vom Parser nicht erkannt
];

const RISK_BADGE: Record<Risk, string> = {
  safe:     'bg-green-100 text-green-700',
  caution:  'bg-amber-100 text-amber-700',
  advanced: 'bg-purple-100 text-purple-700',
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

  const changed = Object.keys(vals);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">ESMTP-Erweiterungen</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Steuert welche EHLO-Capabilities der SMTP-Server ankündigt und akzeptiert
          </p>
        </div>
        <div className="flex items-center gap-3">
          {changed.length > 0 && (
            <span className="text-xs text-amber-600">{changed.length} Änderung{changed.length > 1 ? 'en' : ''}</span>
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
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Erweiterung</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">RFC</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 hidden lg:table-cell">Beschreibung</th>
              <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500">Typ</th>
              <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500">Aktiv</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {EXT_DEFS.map(ext => {
              const active = get(ext.key);
              const modified = ext.key in vals;
              return (
                <tr key={ext.key} className={`hover:bg-gray-50 transition-colors ${modified ? 'bg-accent/5' : ''}`}>
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-xs font-semibold text-gray-800">{ext.label}</span>
                    {ext.warnOff && !active && (
                      <p className="text-[10px] text-amber-600 mt-0.5 flex items-center gap-0.5">
                        <Info size={9} /> {ext.warnOff}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-400 font-mono">{ext.rfc}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 hidden lg:table-cell max-w-xs">{ext.desc}</td>
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

      <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-xs text-blue-700 flex items-start gap-2">
        <Info size={13} className="shrink-0 mt-0.5" />
        <span>
          Änderungen werden in der Datenbank gespeichert und beim nächsten SMTP-Server-Neustart aktiv.
          Die deaktivierten Erweiterungen erscheinen nicht mehr im EHLO-Response.
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
          <h2 className="text-base font-semibold text-gray-900">Lokale Zustellung</h2>
          <p className="text-xs text-gray-400 mt-0.5">Steuert ob der Server eingehende Nachrichten für lokale Postfächer annimmt</p>
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
        <div className={`card p-4 border-2 transition-colors ${enabled ? 'border-green-200 bg-green-50/30' : 'border-gray-200'}`}>
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle size={15} className={enabled ? 'text-green-500' : 'text-gray-300'} />
            <span className="text-sm font-semibold text-gray-800">Aktiviert</span>
          </div>
          <ul className="space-y-1 text-xs text-gray-500">
            <li>• Empfänger werden gegen lokale Postfächer geprüft</li>
            <li>• Verteilergruppen werden aufgelöst</li>
            <li>• Ressourcenpostfächer (Räume) akzeptiert</li>
            <li>• Shared Mailboxes erreichbar</li>
          </ul>
        </div>
        <div className={`card p-4 border-2 transition-colors ${!enabled ? 'border-amber-200 bg-amber-50/30' : 'border-gray-200'}`}>
          <div className="flex items-center gap-2 mb-2">
            <Info size={15} className={!enabled ? 'text-amber-500' : 'text-gray-300'} />
            <span className="text-sm font-semibold text-gray-800">Deaktiviert</span>
          </div>
          <ul className="space-y-1 text-xs text-gray-500">
            <li>• Alle RCPT TO-Befehle werden abgelehnt</li>
            <li>• Server agiert als reiner Relay-Knoten</li>
            <li>• Nützlich für reine Outbound-Server</li>
            <li>• Kein lokaler Postfachspeicher nötig</li>
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

  const defaultBanner = `${window.location.hostname} CoreMail ESMTP`;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">SMTP-Banner</h2>
          <p className="text-xs text-gray-400 mt-0.5">Der Begrüßungstext den der SMTP-Server bei jeder Verbindung sendet (220-Response)</p>
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
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            {override ? 'Benutzerdefinierter Banner' : 'Standard-Banner (aktiv)'}
          </p>
          {override ? (
            <textarea
              value={text}
              onChange={e => setText(e.target.value.slice(0, 255))}
              rows={2}
              placeholder="z.B. mail.example.com ESMTP"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent resize-none"
            />
          ) : (
            <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 font-mono text-sm text-gray-600">
              {defaultBanner}
            </div>
          )}
          <p className="text-xs text-gray-400 mt-1">
            {override ? `${text.length}/255 Zeichen` : 'Hostname + "CoreMail ESMTP"'}
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Vorschau — SMTP-Verbindung</p>
          <div className="bg-gray-900 rounded-lg p-4 font-mono text-xs space-y-1">
            <p className="text-gray-400">{'# telnet mail.example.com 25'}</p>
            <p className="text-green-400">
              {'220 '}
              <span className="text-white">{override && text ? text : defaultBanner}</span>
            </p>
            <p className="text-gray-400">{'EHLO client.example.com'}</p>
            <p className="text-green-400">{'250-mail.example.com'}</p>
            <p className="text-green-400">{'250-STARTTLS'}</p>
            <p className="text-green-400">{'250-AUTH PLAIN LOGIN'}</p>
            <p className="text-green-400">{'250 SIZE 26214400'}</p>
          </div>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700 flex items-start gap-2">
          <Info size={12} className="shrink-0 mt-0.5" />
          <span>
            Der Banner sollte keine detaillierten Software-Versionsinformationen enthalten (Security through obscurity).
            RFC 5321 verlangt, dass der Hostname im Banner erscheint.
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
          <h2 className="text-base font-semibold text-gray-900">Greylisting</h2>
          <p className="text-xs text-gray-400 mt-0.5">Temporäres Abweisen unbekannter Absender beim ersten Verbindungsversuch</p>
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
            <p className="text-lg font-bold text-gray-900">{c.value}</p>
            <p className="text-xs text-gray-400">{c.label}</p>
            <p className="text-[10px] text-gray-300 mt-0.5">{c.sub}</p>
          </div>
        ))}
      </div>

      {/* Ablauf-Illustration */}
      <div className="card p-4 space-y-3">
        <p className="text-sm font-semibold text-gray-700">Ablauf</p>
        <div className="flex items-start gap-3">
          {[
            { step: '1', label: 'Erstversuch', color: 'bg-red-100 text-red-700', desc: `SMTP-Server antwortet: "451 4.7.1 Greylisted — try again in ${waitMin} min"` },
            { step: '2', label: `Nach ${waitMin} Min`, color: 'bg-amber-100 text-amber-700', desc: 'Legitimer Mailserver wiederholt den Versuch automatisch' },
            { step: '3', label: 'Akzeptiert', color: 'bg-green-100 text-green-700', desc: `Triplet wird ${ttl}h whitegelistet — alle weiteren Versuche sofort akzeptiert` },
          ].map((item, i) => (
            <div key={i} className="flex-1 flex flex-col items-center text-center">
              <div className={`w-8 h-8 rounded-full ${item.color} flex items-center justify-center font-bold text-sm mb-1`}>
                {item.step}
              </div>
              <p className="text-xs font-semibold text-gray-700 mb-1">{item.label}</p>
              <p className="text-[10px] text-gray-400 leading-relaxed">{item.desc}</p>
              {i < 2 && (
                <div className="absolute right-0 top-3 text-gray-300">→</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Whitelist */}
      <div className="card p-4 space-y-3">
        <p className="text-sm font-semibold text-gray-700">
          Greylisting-Whitelist
          <span className="text-xs font-normal text-gray-400 ml-2">IPs / CIDR / Hostnamen die nie gegreylistet werden</span>
        </p>
        {whitelist.length === 0 && (
          <p className="text-xs text-gray-400 italic">Keine Einträge — alle unbekannten Absender werden gegreylistet</p>
        )}
        <div className="space-y-1.5">
          {whitelist.map(e => (
            <div key={e} className="flex items-center justify-between bg-gray-50 rounded px-3 py-1.5">
              <span className="text-sm font-mono text-gray-700">{e}</span>
              <button onClick={() => setWhitelist(prev => prev.filter(x => x !== e))}
                className="text-gray-400 hover:text-red-500 transition-colors">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={newEntry} onChange={e => setNewEntry(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addEntry()}
            placeholder="z.B. 192.168.1.0/24 oder mx.google.com"
            className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button onClick={addEntry} className="btn-secondary text-sm gap-1">
            <Plus size={13} /> Hinzufügen
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-gray-100">
          <p className="w-full text-xs text-gray-400 mb-0.5">Schnell hinzufügen:</p>
          {['127.0.0.1','::1','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'].filter(e => !whitelist.includes(e)).map(e => (
            <button key={e} onClick={() => setWhitelist(prev => [...prev, e])}
              className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-2 py-0.5 rounded font-mono transition-colors">
              + {e}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// RelayingSection
// ═════════════════════════════════════════════════════════════════════════════

function RelayingSection({ s, onSave, pending }: { s: SmtpSettings; onSave: (d: Partial<SmtpSettings>) => void; pending: boolean }) {
  const [enabled,      setEnabled]     = useState(s.relayingEnabled);
  const [requireAuth,  setRequireAuth] = useState(s.relayRequireAuth);
  const [domains,      setDomains]     = useState<string[]>(s.relayDomains);
  const [trustedIps,   setTrustedIps]  = useState<string[]>(s.relayTrustedIps);
  const [newDomain,    setNewDomain]   = useState('');
  const [newIp,        setNewIp]       = useState('');

  function add(list: string[], setList: (v: string[]) => void, val: string) {
    const e = val.trim().toLowerCase();
    if (!e || list.includes(e)) return;
    setList([...list, e]);
  }

  function save() {
    onSave({ relayingEnabled: enabled, relayRequireAuth: requireAuth, relayDomains: domains, relayTrustedIps: trustedIps });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Relaying — Weiterleitung</h2>
          <p className="text-xs text-gray-400 mt-0.5">Konfiguriert für welche fremden Domains E-Mails weitergeleitet werden</p>
        </div>
        <SaveBtn onClick={save} pending={pending} />
      </div>

      {!enabled && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-700 flex items-center gap-2">
          <CheckCircle size={15} />
          <span><strong>Open Relay deaktiviert</strong> — E-Mails werden nur für lokale Domains angenommen. Empfohlene Einstellung.</span>
        </div>
      )}
      {enabled && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700 flex items-start gap-2">
          <Info size={15} className="shrink-0 mt-0.5" />
          <span>
            <strong>Relay aktiv</strong> — Stellen Sie sicher, dass Relay nur für autorisierte Absender/Domains erlaubt ist
            um Open-Relay-Missbrauch zu verhindern.
          </span>
        </div>
      )}

      <div className="card p-5 space-y-0">
        <ToggleRow
          label="Relaying aktiviert"
          desc="E-Mails für Domains außerhalb des lokalen Systems weiterleiten"
          value={enabled}
          onChange={setEnabled}
        />
        {enabled && (
          <ToggleRow
            label="Authentifizierung erforderlich"
            desc="Relay nur für authentifizierte SMTP-Sessions erlauben (AUTH-Befehl)"
            value={requireAuth}
            onChange={setRequireAuth}
          />
        )}
      </div>

      {enabled && (
        <>
          {/* Relay Domains */}
          <div className="card p-4 space-y-3">
            <div>
              <p className="text-sm font-semibold text-gray-700">Relay-Domains</p>
              <p className="text-xs text-gray-400 mt-0.5">Für diese Domains werden eingehende Nachrichten weitergeleitet (leer = kein Domain-Relay)</p>
            </div>
            {domains.length === 0 && (
              <p className="text-xs text-gray-400 italic">Keine Relay-Domains konfiguriert</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {domains.map(d => (
                <span key={d} className="flex items-center gap-1 bg-blue-50 border border-blue-200 text-blue-700 text-xs px-2 py-0.5 rounded-full font-mono">
                  {d}
                  <button onClick={() => setDomains(prev => prev.filter(x => x !== d))}
                    className="hover:text-red-600 ml-0.5">×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={newDomain} onChange={e => setNewDomain(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { add(domains, setDomains, newDomain); setNewDomain(''); } }}
                placeholder="z.B. example.com"
                className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <button onClick={() => { add(domains, setDomains, newDomain); setNewDomain(''); }}
                className="btn-secondary text-sm gap-1">
                <Plus size={13} /> Hinzufügen
              </button>
            </div>
          </div>

          {/* Trusted IPs */}
          <div className="card p-4 space-y-3">
            <div>
              <p className="text-sm font-semibold text-gray-700">Vertrauenswürdige IPs (Relay ohne Auth)</p>
              <p className="text-xs text-gray-400 mt-0.5">Diese IP-Adressen/CIDR-Ranges dürfen ohne Authentifizierung weiterleiten</p>
            </div>
            {trustedIps.length === 0 && (
              <p className="text-xs text-gray-400 italic">Keine vertrauenswürdigen IPs — Relay nur via AUTH</p>
            )}
            <div className="space-y-1.5">
              {trustedIps.map(ip => (
                <div key={ip} className="flex items-center justify-between bg-gray-50 rounded px-3 py-1.5">
                  <span className="text-sm font-mono text-gray-700">{ip}</span>
                  <button onClick={() => setTrustedIps(prev => prev.filter(x => x !== ip))}
                    className="text-gray-400 hover:text-red-500 transition-colors">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={newIp} onChange={e => setNewIp(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { add(trustedIps, setTrustedIps, newIp); setNewIp(''); } }}
                placeholder="z.B. 10.0.0.0/8"
                className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <button onClick={() => { add(trustedIps, setTrustedIps, newIp); setNewIp(''); }}
                className="btn-secondary text-sm gap-1">
                <Plus size={13} /> Hinzufügen
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1 border-t border-gray-100">
              <p className="w-full text-xs text-gray-400 mb-0.5">Lokale Netze:</p>
              {['127.0.0.0/8','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'].filter(e => !trustedIps.includes(e)).map(e => (
                <button key={e} onClick={() => setTrustedIps(prev => [...prev, e])}
                  className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-2 py-0.5 rounded font-mono transition-colors">
                  + {e}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// OutgoingSection — Ausgehende Zustellung: MX direkt oder Smarthost
// ═════════════════════════════════════════════════════════════════════════════

function OutgoingSection({ s, onSave, pending }: { s: SmtpSettings; onSave: (d: Partial<SmtpSettings>) => void; pending: boolean }) {
  const [mode, setMode]               = useState<'mx' | 'smarthost'>(s.outboundMode ?? 'mx');
  const [host, setHost]               = useState(s.smarthostHost ?? '');
  const [port, setPort]               = useState(s.smarthostPort ?? 587);
  const [tls, setTls]                 = useState(s.smarthostTls ?? true);
  const [implicitTls, setImplicitTls] = useState(s.smarthostImplicitTls ?? false);
  const [username, setUsername]       = useState(s.smarthostUsername ?? '');
  const [password, setPassword]       = useState('');  // nie vorausgefüllt (Sicherheit)
  const [filterEnabled, setFilterEnabled] = useState(s.outboundFilterEnabled ?? true);

  const [testStatus, setTestStatus]   = useState<'idle' | 'testing' | 'ok' | 'err'>('idle');
  const [testMsg, setTestMsg]         = useState('');

  // Implizites TLS → STARTTLS deaktivieren (gegenseitig exklusiv)
  function handleImplicitTls(v: boolean) {
    setImplicitTls(v);
    if (v) setTls(false);
  }
  function handleStarttls(v: boolean) {
    setTls(v);
    if (v) setImplicitTls(false);
  }

  // Port-Vorschläge je nach TLS-Modus
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
      const res = await fetch('/api/v1/admin/smtp-config/test-smarthost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('accessToken') ?? ''}` },
        body: JSON.stringify({ host, port, tls, implicitTls, username, password: password || undefined }),
      });
      const data = await res.json() as { ok: boolean; message: string };
      setTestStatus(data.ok ? 'ok' : 'err');
      setTestMsg(data.message);
    } catch {
      setTestStatus('err');
      setTestMsg('Verbindungstest fehlgeschlagen');
    }
  }

  function handleSave() {
    const payload: Partial<SmtpSettings> = {
      outboundMode:          mode,
      smarthostHost:         host,
      smarthostPort:         port,
      smarthostTls:          tls,
      smarthostImplicitTls:  implicitTls,
      smarthostUsername:     username,
      outboundFilterEnabled: filterEnabled,
    };
    if (password) payload.smarthostPassword = password;
    onSave(payload);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Ausgehende Zustellung</h2>
          <p className="text-xs text-gray-400 mt-0.5">
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
                ? 'border-accent bg-accent/5'
                : 'border-gray-200 hover:border-gray-300 bg-white'
            }`}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xl">{opt.icon}</span>
              <span className="font-semibold text-sm text-gray-800">{opt.label}</span>
              {mode === opt.value && (
                <CheckCircle size={14} className="ml-auto text-accent" />
              )}
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">{opt.desc}</p>
          </button>
        ))}
      </div>

      {/* MX Info */}
      {mode === 'mx' && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-xs text-green-800 flex items-start gap-2">
          <CheckCircle size={13} className="shrink-0 mt-0.5 text-green-600" />
          <div>
            <span className="font-semibold">Direkte MX-Zustellung aktiv</span>
            <p className="mt-0.5 text-green-700">
              CoreMail stellt Mails direkt an den Ziel-Mailserver zu. Stelle sicher, dass Port 25
              ausgehend von deinem Server nicht geblockt ist und ein gültiger PTR-/DMARC-Record gesetzt ist.
            </p>
          </div>
        </div>
      )}

      {/* Spam-/Virenfilter */}
      <div className="card p-5 space-y-0">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pb-3 border-b border-gray-100">Sicherheitsfilter</p>
        <ToggleRow
          label="Spam-/Virenfilter vor Weiterleitung anwenden"
          desc="Ausgehende Mails werden vor dem Versand durch rspamd (Anti-Spam) und ClamAV (Antivirus) geprüft. Empfohlen um sicherzustellen, dass kein infizierter oder als Spam eingestufter Inhalt versendet wird."
          value={filterEnabled}
          onChange={setFilterEnabled}
        />
      </div>

      {/* Smarthost Settings */}
      {mode === 'smarthost' && (
        <div className="space-y-4">
          {/* Host + Port */}
          <div className="card p-5 space-y-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-2">Verbindung</p>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-600 mb-1">Smarthost / Relay-Server</label>
                <input
                  value={host} onChange={e => setHost(e.target.value)}
                  placeholder="z.B. smtp.sendgrid.net"
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Port</label>
                <input
                  type="number" min={1} max={65535} value={port}
                  onChange={e => setPort(parseInt(e.target.value, 10) || 587)}
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm text-right font-mono focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            </div>

            {/* Port-Schnellauswahl */}
            <div className="flex flex-wrap gap-1.5">
              <span className="text-xs text-gray-400 self-center">Schnell:</span>
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
                      ? 'bg-accent text-white border-accent'
                      : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* TLS */}
          <div className="card p-5 space-y-0">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pb-3 border-b border-gray-100">TLS-Verschlüsselung</p>
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
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-2">Authentifizierung (optional)</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Benutzername</label>
                <input
                  value={username} onChange={e => setUsername(e.target.value)}
                  placeholder="z.B. apikey oder user@domain.de"
                  autoComplete="off"
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Passwort
                  {s.smarthostPassword === '••••••••' && (
                    <span className="ml-1.5 text-gray-400 font-normal">(gespeichert — leer lassen um beizubehalten)</span>
                  )}
                </label>
                <input
                  type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder={s.smarthostPassword === '••••••••' ? '••••••••' : 'Kein Passwort gesetzt'}
                  autoComplete="new-password"
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
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
                <span className="flex items-center gap-1.5 text-sm text-green-700">
                  <CheckCircle size={14} /> {testMsg}
                </span>
              )}
              {testStatus === 'err' && (
                <span className="flex items-center gap-1.5 text-sm text-red-600">
                  <XCircle size={14} /> {testMsg}
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Testet die SMTP-Verbindung ohne E-Mails zu senden. Verwendete Einstellungen: aktueller Formularinhalt (noch nicht gespeichert).
            </p>
          </div>

          {/* Provider Presets */}
          <div className="card p-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Bekannte Anbieter</p>
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
                  className="text-left px-3 py-2 rounded border border-gray-200 hover:border-accent hover:bg-accent/5 transition-colors"
                >
                  <p className="text-xs font-semibold text-gray-700">{p.name}</p>
                  <p className="text-[10px] text-gray-400 font-mono">{p.host}:{p.port}</p>
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
          <h2 className="text-base font-semibold text-gray-900">Verbindungseinstellungen</h2>
          <p className="text-xs text-gray-400 mt-0.5">Limits und Timeouts für SMTP-Verbindungen und Nachrichten</p>
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
            <p className="text-xl font-bold text-gray-900">{c.value.toLocaleString()}</p>
            <p className="text-xs text-gray-400">{c.label}</p>
          </div>
        ))}
      </div>

      {/* Verbindungslimits */}
      <div className="card p-5 space-y-0">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pb-3 border-b border-gray-100">Verbindungslimits</p>
        <NumInput label="Maximale gleichzeitige Verbindungen"
          desc="Gesamtanzahl aktiver SMTP-Verbindungen (alle IPs)"
          value={vals.maxConnections} onChange={v => set('maxConnections', v)} min={1} max={10000} unit="Verb." />
        <NumInput label="Maximale Verbindungen pro IP"
          desc="Verhindert DDoS/Spam von einzelnen IP-Adressen"
          value={vals.maxConnectionsPerIp} onChange={v => set('maxConnectionsPerIp', v)} min={1} max={1000} unit="Verb." />
        <NumInput label="Maximale Empfänger pro Nachricht"
          desc="Anzahl RCPT TO-Befehle pro Mail-Transaktion"
          value={vals.maxRecipients} onChange={v => set('maxRecipients', v)} min={1} max={10000} unit="Empf." />
        <NumInput label="Maximale Auth-Fehlversuche"
          desc="Verbindung wird nach dieser Anzahl fehlgeschlagener AUTH-Versuche getrennt"
          value={vals.maxAuthFailures} onChange={v => set('maxAuthFailures', v)} min={1} max={100} />
      </div>

      {/* Nachrichtengröße */}
      <div className="card p-5 space-y-0">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pb-3 border-b border-gray-100">Nachrichtengröße</p>
        <NumInput label="Maximale Nachrichtengröße"
          desc="Nachrichten größer als dieser Wert werden mit 552 abgelehnt"
          value={vals.maxMessageSizeMb} onChange={v => set('maxMessageSizeMb', v)} min={1} max={500} unit="MB" />
      </div>

      {/* Timeouts */}
      <div className="card p-5 space-y-0">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pb-3 border-b border-gray-100">Timeouts & Verzögerungen</p>
        <NumInput label="Verbindungs-Timeout"
          desc="Inaktive Verbindungen werden nach dieser Zeit getrennt (RFC 5321: min. 300s)"
          value={vals.connectionTimeoutSec} onChange={v => set('connectionTimeoutSec', v)} min={30} max={3600} unit="Sek" />
        <NumInput label="Greeting Delay"
          desc="Künstliche Verzögerung der 220-Antwort — hilft gegen Spam-Bots die sofort Daten senden"
          value={vals.greetingDelaySec} onChange={v => set('greetingDelaySec', v)} min={0} max={30} unit="Sek" />
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-xs text-blue-700 flex items-start gap-2">
        <Info size={13} className="shrink-0 mt-0.5" />
        <span>
          RFC 5321 schreibt Mindest-Timeouts vor: EHLO/HELO 5 Min, MAIL 5 Min, DATA-Initiierung 2 Min, DATA-Block 3 Min.
          Der Verbindungs-Timeout sollte mindestens 300 Sek. betragen.
        </span>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// DnsSection — DNS-Einträge für Mail-Betrieb
// ═════════════════════════════════════════════════════════════════════════════

interface DomainItem { id: string; name: string; primary: boolean; dkimSelector: string }
interface DomainsResp { domains: DomainItem[] }

interface DnsRecord {
  type: string;
  name: string;
  expected: string;
  ok: boolean;
  found: string | null;
}
interface DnsCheckResult {
  domain: string;
  hostname: string;
  records: {
    mx:           DnsRecord;
    spf:          DnsRecord;
    dkim:         DnsRecord;
    dmarc:        DnsRecord;
    autodiscover: DnsRecord;
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
    <button
      onClick={handleCopy}
      title="Kopieren"
      className="shrink-0 p-1 rounded text-gray-400 hover:text-accent hover:bg-accent/10 transition-colors"
    >
      {copied
        ? <Check size={size} className="text-green-500" />
        : <Copy size={size} />}
    </button>
  );
}

// ── StatusDot — gefüllter Kreis: grün = gesetzt, gelb = fehlt ────────────────
function StatusDot({ ok, checking }: { ok: boolean; checking: boolean }) {
  if (checking) return <Loader2 size={14} className="animate-spin text-gray-400 shrink-0" />;
  return (
    <span className={`inline-block w-3 h-3 rounded-full shrink-0 mt-0.5 ${
      ok ? 'bg-green-500' : 'bg-yellow-400'
    }`} />
  );
}

// ── DnsRow — eine Zeile in der DNS-Tabelle ────────────────────────────────────
interface DnsRowProps {
  label:       string;
  description: string;
  record:      DnsRecord;
  checking:    boolean;
  isLast?:     boolean;
}
function DnsRow({ label, description, record, checking, isLast }: DnsRowProps) {
  return (
    <div className={`grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 py-4 ${isLast ? '' : 'border-b border-gray-100'}`}>
      {/* Status-Punkt (linke Spalte, zwei Zeilen hoch) */}
      <div className="flex items-start pt-0.5">
        <StatusDot ok={record.ok} checking={checking} />
      </div>

      {/* Rechte Spalte: alles */}
      <div className="space-y-2 min-w-0">
        {/* Labelzeile */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-gray-900">{label}</span>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-mono border border-gray-200">
            {record.type}
          </span>
          {!checking && (
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
              record.ok
                ? 'bg-green-100 text-green-700'
                : 'bg-yellow-100 text-yellow-700'
            }`}>
              {record.ok ? '● Gesetzt' : '○ Nicht gefunden'}
            </span>
          )}
        </div>

        <p className="text-xs text-gray-400 leading-relaxed">{description}</p>

        {/* DNS-Name + Kopieren */}
        <div className="flex items-center gap-1 bg-gray-50 rounded border border-gray-200 px-2 py-1.5">
          <span className="text-[10px] text-gray-400 font-medium mr-1 shrink-0">Name</span>
          <code className="flex-1 text-xs text-gray-600 font-mono break-all">{record.name}</code>
          <CopyBtn text={record.name} />
        </div>

        {/* Erwarteter Wert + Kopieren */}
        <div className="flex items-start gap-1 bg-gray-50 rounded border border-gray-200 px-2 py-1.5">
          <span className="text-[10px] text-gray-400 font-medium mr-1 mt-0.5 shrink-0">Wert</span>
          <code className="flex-1 text-xs text-gray-800 font-mono break-all leading-relaxed">{record.expected}</code>
          <CopyBtn text={record.expected} />
        </div>

        {/* Aktuell in DNS gefunden */}
        {!checking && record.ok && record.found && (
          <div className="flex items-start gap-1.5 bg-green-50 border border-green-200 rounded px-2 py-1.5">
            <CheckCircle size={11} className="text-green-500 shrink-0 mt-0.5" />
            <code className="text-[11px] text-green-800 font-mono break-all leading-relaxed">{record.found}</code>
          </div>
        )}
        {!checking && !record.ok && record.found && (
          <div className="flex items-start gap-1.5 bg-yellow-50 border border-yellow-200 rounded px-2 py-1.5">
            <AlertCircle size={11} className="text-yellow-600 shrink-0 mt-0.5" />
            <span className="text-[11px] text-yellow-800">
              Gefunden, aber abweichend: <code className="font-mono">{record.found}</code>
            </span>
          </div>
        )}
        {!checking && !record.ok && !record.found && (
          <div className="flex items-center gap-1.5 bg-yellow-50 border border-yellow-200 rounded px-2 py-1.5">
            <AlertCircle size={11} className="text-yellow-500 shrink-0" />
            <span className="text-[11px] text-yellow-700">Kein Eintrag gefunden — beim DNS-Anbieter eintragen</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── PTR-Zeile (kein API-Check, immer manuell beim Hoster) ────────────────────
function PtrRow({ hostname }: { hostname: string }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 py-4">
      <div className="flex items-start pt-0.5">
        <span className="inline-block w-3 h-3 rounded-full shrink-0 mt-0.5 bg-blue-400" />
      </div>
      <div className="space-y-2 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-gray-900">Reverse DNS (PTR)</span>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-mono border border-gray-200">PTR</span>
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
            Beim Hosting-Anbieter setzen
          </span>
        </div>
        <p className="text-xs text-gray-400 leading-relaxed">
          Wird im Server-Panel des Hosters (Hetzner, Contabo, Netcup …) gesetzt — nicht beim DNS-Provider.
          Ohne PTR lehnen GMail und viele andere Mailserver eingehende Verbindungen ab.
        </p>
        <div className="flex items-start gap-1 bg-gray-50 rounded border border-gray-200 px-2 py-1.5">
          <span className="text-[10px] text-gray-400 font-medium mr-1 mt-0.5 shrink-0">Wert</span>
          <code className="flex-1 text-xs text-gray-800 font-mono break-all">{hostname}</code>
          <CopyBtn text={hostname} />
        </div>
      </div>
    </div>
  );
}

// ── DnsSection (Hauptkomponente) ──────────────────────────────────────────────
function DnsSection() {
  const [selectedDomainId, setSelectedDomainId] = useState<string>('');
  const [checkKey, setCheckKey] = useState(0);

  // Alle Domains laden
  const { data: domainsData } = useQuery({
    queryKey: ['admin-domains-dns'],
    queryFn:  () => api.get<DomainsResp>('/admin/domains?limit=100'),
    select:   d => d.domains,
  });

  const domains            = domainsData ?? [];
  const effectiveDomainId  = selectedDomainId || (domains.find(d => d.primary)?.id ?? domains[0]?.id ?? '');
  const selectedDomain     = domains.find(d => d.id === effectiveDomainId);

  // DNS-Check für gewählte Domain
  const { data: dnsCheck, isFetching: checking } = useQuery({
    queryKey:  ['dns-check', effectiveDomainId, checkKey],
    queryFn:   () => api.get<DnsCheckResult>(`/admin/domains/${effectiveDomainId}/dns-check`),
    enabled:   !!effectiveDomainId,
    staleTime: 0,
    gcTime:    0,
  });

  const okCount = dnsCheck ? Object.values(dnsCheck.records).filter(r => r.ok).length : 0;
  const allOk   = okCount === 5;

  // Skeleton-Records für Ladestand
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
      description: 'Legt fest welche Server im Namen der Domain senden dürfen — verhindert E-Mail-Spoofing',
      fallback:    emptyRecord('TXT',   selectedDomain?.name ?? '', 'v=spf1 a:… mx ~all'),
    },
    {
      key:         'dkim',
      label:       `DKIM — Signatur (Selektor: ${selectedDomain?.dkimSelector ?? 'coremail'})`,
      description: 'Kryptografische Signatur — beweist Absenderauthentizität und verhindert Manipulation',
      fallback:    emptyRecord('TXT',   `${selectedDomain?.dkimSelector ?? 'coremail'}._domainkey.${selectedDomain?.name ?? '…'}`, 'v=DKIM1; k=rsa; p=…'),
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
      description: 'Ermöglicht Outlook und iOS Mail die automatische Server-Konfiguration per E-Mail-Adresse',
      fallback:    emptyRecord('CNAME', `autodiscover.${selectedDomain?.name ?? '…'}`, dnsCheck?.hostname ?? '…'),
    },
  ];

  return (
    <div className="space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">DNS-Einträge</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Notwendige Einträge beim DNS-Anbieter für zuverlässigen Mail-Betrieb
          </p>
        </div>
        <button
          onClick={() => setCheckKey(k => k + 1)}
          disabled={!effectiveDomainId || checking}
          className="flex items-center gap-1.5 text-sm text-accent border border-accent/30 hover:bg-accent/5 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
        >
          <RefreshCw size={13} className={checking ? 'animate-spin' : ''} />
          Prüfen
        </button>
      </div>

      {/* ── Domain-Tabs (nur bei mehreren Domains) ─────────────────────── */}
      {domains.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {domains.map(d => (
            <button
              key={d.id}
              onClick={() => { setSelectedDomainId(d.id); setCheckKey(k => k + 1); }}
              className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
                d.id === effectiveDomainId
                  ? 'bg-accent text-white border-accent'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-accent/40'
              }`}
            >
              {d.name}
              {d.primary && <span className="ml-1.5 text-[10px] opacity-70">primär</span>}
            </button>
          ))}
        </div>
      )}

      {/* ── Keine Domains ──────────────────────────────────────────────── */}
      {domains.length === 0 && (
        <div className="card p-8 text-center text-sm text-gray-400">
          Keine Domains — bitte zuerst eine Domain unter <strong>Domains</strong> anlegen.
        </div>
      )}

      {/* ── Status-Banner ──────────────────────────────────────────────── */}
      {dnsCheck && !checking && (
        <div className={`rounded-lg px-4 py-3 flex items-center gap-3 border ${
          allOk ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'
        }`}>
          <span className={`w-3 h-3 rounded-full shrink-0 ${allOk ? 'bg-green-500' : 'bg-yellow-400'}`} />
          <div>
            <p className={`text-sm font-semibold ${allOk ? 'text-green-800' : 'text-yellow-800'}`}>
              {allOk
                ? `Alle 5 Einträge für ${dnsCheck.domain} sind gesetzt ✓`
                : `${okCount} von 5 Einträgen gesetzt — ${5 - okCount} ${5 - okCount === 1 ? 'fehlt' : 'fehlen'} noch`}
            </p>
            <p className={`text-xs mt-0.5 ${allOk ? 'text-green-700' : 'text-yellow-700'}`}>
              Mailserver: <strong className="font-mono">{dnsCheck.hostname}</strong>
            </p>
          </div>
        </div>
      )}

      {/* ── DNS-Tabelle ─────────────────────────────────────────────────── */}
      {(domains.length > 0) && (
        <div className="card divide-y divide-gray-100 overflow-hidden">
          {/* Tabellen-Header */}
          <div className="px-4 py-2 bg-gray-50 flex items-center gap-2">
            <Globe size={12} className="text-gray-400" />
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
              {selectedDomain?.name ?? '…'}
            </span>
            {checking && <Loader2 size={11} className="animate-spin text-gray-400 ml-auto" />}
          </div>

          {/* Zeilen */}
          <div className="px-4">
            {rows.map((row, i) => (
              <DnsRow
                key={row.key}
                label={row.label}
                description={row.description}
                record={dnsCheck?.records[row.key] ?? row.fallback}
                checking={checking && !dnsCheck}
                isLast={i === rows.length - 1}
              />
            ))}

            {/* PTR-Zeile (immer, sobald hostname bekannt) */}
            {(dnsCheck || selectedDomain) && (
              <PtrRow hostname={dnsCheck?.hostname ?? selectedDomain?.name ?? '…'} />
            )}
          </div>
        </div>
      )}

      {/* ── Legende ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-5 text-xs text-gray-500 px-1">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-green-500 inline-block" /> Eintrag gesetzt
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-yellow-400 inline-block" /> Nicht gefunden
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-blue-400 inline-block" /> Manuell beim Hoster
        </span>
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
    onError: () => toast.error('Fehler beim Speichern'),
  });

  return (
    <div className="flex h-full">
      {/* ── Left sub-nav ────────────────────────────────────────────────── */}
      <aside className="w-44 shrink-0 bg-[#1e2433] flex flex-col h-full">
        <div className="px-3 py-3 border-b border-white/10">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">SMTP-Konfiguration</p>
        </div>
        <nav className="flex-1 py-2 space-y-0.5">
          {SUB_NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setSection(id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                section === id
                  ? 'bg-white/10 text-white border-l-2 border-accent'
                  : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
              }`}>
              <Icon size={13} className="shrink-0" />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* DNS-Reiter braucht keine SmtpSettings — immer renderfähig */}
        {section === 'dns' && <DnsSection />}

        {section !== 'dns' && (
          !settings ? (
            <div className="text-sm text-gray-400">Lade SMTP-Einstellungen…</div>
          ) : (
            <>
              {section === 'esmtp'       && <EsmtpSection       s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
              {section === 'delivery'    && <DeliverySection    s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
              {section === 'outgoing'    && <OutgoingSection    s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
              {section === 'banner'      && <BannerSection      s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
              {section === 'greylisting' && <GreylistingSection s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
              {section === 'relaying'    && <RelayingSection    s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
              {section === 'connection'  && <ConnectionSection  s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
            </>
          )
        )}
      </div>
    </div>
  );
}
