import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Terminal, Package, MessageSquare, Clock, ArrowRightLeft,
  Network, Plus, Trash2, CheckCircle, Info,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SmtpSettings {
  extStarttls:          boolean;
  extAuthPlain:         boolean;
  extAuthLogin:         boolean;
  extAuthCramMd5:       boolean;
  extPipelining:        boolean;
  extSize:              boolean;
  ext8bitmime:          boolean;
  extEnhancedStatus:    boolean;
  extSmtputf8:          boolean;
  extDsn:               boolean;
  extChunking:          boolean;
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
}

// ── Sub-Navigation ────────────────────────────────────────────────────────────

type Section = 'esmtp' | 'delivery' | 'banner' | 'greylisting' | 'relaying' | 'connection';

const SUB_NAV: { id: Section; label: string; icon: React.ElementType }[] = [
  { id: 'esmtp',       label: 'ESMTP-Befehle',    icon: Terminal },
  { id: 'delivery',    label: 'Lokale Zustellung', icon: Package },
  { id: 'banner',      label: 'SMTP-Banner',       icon: MessageSquare },
  { id: 'greylisting', label: 'Greylisting',       icon: Clock },
  { id: 'relaying',    label: 'Relaying',          icon: ArrowRightLeft },
  { id: 'connection',  label: 'Verbindung',        icon: Network },
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
      <button
        onClick={() => onChange(!value)}
        style={{ height: 22, width: 40, flexShrink: 0 }}
        className={`relative rounded-full transition-colors ${value ? 'bg-accent' : 'bg-gray-300'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
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
  { key: 'extAuthCramMd5',    label: 'AUTH CRAM-MD5',    rfc: 'RFC 2195',  risk: 'caution',
    desc: 'Challenge-Response-Authentifizierung mit HMAC-MD5 (veraltet, MD5 gebrochen)' },
  { key: 'extPipelining',     label: 'PIPELINING',       rfc: 'RFC 2920',  risk: 'safe',
    desc: 'Mehrere SMTP-Befehle in einem TCP-Paket senden — beschleunigt Verbindungen' },
  { key: 'extSize',           label: 'SIZE',             rfc: 'RFC 1870',  risk: 'safe',
    desc: 'Maximale Nachrichtengröße im EHLO-Greeting ankündigen' },
  { key: 'ext8bitmime',       label: '8BITMIME',         rfc: 'RFC 6152',  risk: 'safe',
    desc: '8-Bit-Daten in SMTP-Nachrichten ohne MIME-Encoding erlauben' },
  { key: 'extEnhancedStatus', label: 'ENHANCEDSTATUSCODES', rfc: 'RFC 2034', risk: 'safe',
    desc: 'Erweiterte SMTP-Statuscodes (z.B. 5.7.1) für bessere Fehlerdiagnose' },
  { key: 'extSmtputf8',       label: 'SMTPUTF8',         rfc: 'RFC 6531',  risk: 'advanced',
    desc: 'Internationalisierte E-Mail-Adressen (UTF-8 in Envelope/Header)' },
  { key: 'extDsn',            label: 'DSN',              rfc: 'RFC 3461',  risk: 'safe',
    desc: 'Delivery Status Notifications — Zustellbenachrichtigungen anfordern' },
  { key: 'extChunking',       label: 'CHUNKING (BDAT)',  rfc: 'RFC 3030',  risk: 'advanced',
    desc: 'Nachrichten in Chunks übertragen (BDAT-Befehl) anstatt DATA' },
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
                    <button
                      onClick={() => set(ext.key, !active)}
                      style={{ height: 20, width: 36 }}
                      className={`relative rounded-full transition-colors ${active ? 'bg-accent' : 'bg-gray-300'}`}
                    >
                      <span className={`absolute top-0.5 w-3.5 h-3.5 bg-white rounded-full shadow transition-transform ${active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
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
        {!settings ? (
          <div className="text-sm text-gray-400">Lade SMTP-Einstellungen…</div>
        ) : (
          <>
            {section === 'esmtp'       && <EsmtpSection       s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
            {section === 'delivery'    && <DeliverySection    s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
            {section === 'banner'      && <BannerSection      s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
            {section === 'greylisting' && <GreylistingSection s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
            {section === 'relaying'    && <RelayingSection    s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
            {section === 'connection'  && <ConnectionSection  s={settings} onSave={d => saveMut.mutate(d)} pending={saveMut.isPending} />}
          </>
        )}
      </div>
    </div>
  );
}
