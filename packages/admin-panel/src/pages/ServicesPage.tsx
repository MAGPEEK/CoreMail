/**
 * BCP → "Protokolle & Dienste" (w2b, route /services): one page for both things that switch a
 * protocol — the ports it listens on (listeners: active, TLS mode, legacy TLS,
 * address/port) and the server-wide access after the login (protocol switches;
 * domains and mailboxes override them in their own dialogs). Per protocol: the
 * access switch, its ports, a summary line with the overriding domains /
 * mailboxes, the consistency warnings and softer notices of
 * GET /admin/protocol-access/overview. Writes use the existing routes
 * (/admin/protocol-access, /admin/services/*). Each card has an anchor id
 * (protocolAnchorId) — old /services/<sub> links redirect there (main.tsx).
 */
import { useEffect, useId, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Lock, Loader2, AlertTriangle, CheckCircle2, Globe, Info, Inbox, ChevronDown, ChevronUp } from 'lucide-react';
import toast from 'react-hot-toast';
import { Modal } from '../components/Modal.js';
import { api } from '../api/client.js';
import { Toggle } from '../components/Toggle.js';
import { Can } from '../components/Can.js';
import { errorMessage } from '../lib/errors.js';
import { LEGACY_TLS_HINT, LEGACY_TLS_LABEL, LEGACY_TLS_WARNING, httpsStatusText, listenerPayload, type ListenerForm } from '../lib/legacyClients.js';
import type { ProtocolLevelView } from '../lib/protocolAccess.js';
import {
  hiddenNamesText, httpsName, legacyServicesTarget, listenerSlug, noticeText, orderedRows, overrideEntryLabel, overrideLink, overrideSummary, PROTOCOL_NAMES,
  protocolAnchorId, SMTP_INBOUND_ANCHOR, summaryLine, warningText,
  type HttpsState, type ListenerService, type OverrideGroup, type OverviewNotice, type OverviewPort, type OverviewWarning,
  type ProtocolOverview, type ProtocolOverviewRow,
} from '../lib/protocolOverview.js';
import { useT } from '../i18n/useT.js';

const OVERVIEW_KEY = ['protocol-overview'] as const;

function useInvalidateOverview(): () => void {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
    void qc.invalidateQueries({ queryKey: ['protocol-access'] });
    void qc.invalidateQueries({ queryKey: ['services-overview'] });
  };
}

// ── Legacy TLS warning (listener modal, port table, HTTPS card) ───────────────
function LegacyTlsWarning() {
  return (
    <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-lg border border-warning-line bg-warning-bg px-3 py-2 text-[11px] text-warning-fg">
      <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{LEGACY_TLS_WARNING}</span>
    </p>
  );
}

/** Under the switch while it is off: an optional extra, not a requirement. */
function LegacyTlsHint() {
  return <p className="mt-1 text-[11px] text-fg-subtle">{LEGACY_TLS_HINT}</p>;
}

function LegacyTlsBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-warning-bg text-warning-fg border border-warning-line"
      title={LEGACY_TLS_WARNING}>
      <AlertTriangle size={10} aria-hidden="true" /> TLS 1.0/1.1
    </span>
  );
}

// ── Listener modal ────────────────────────────────────────────────────────────
function ListenerModal({ initial, smtp, onSave, onClose, saving }: {
  initial?: Partial<ListenerForm>;
  /** SMTP listeners: the port decides between sending (465/587) and receiving. */
  smtp: boolean;
  onSave:  (data: ListenerForm) => void;
  onClose: () => void;
  saving:  boolean;
}) {
  const [form, setForm] = useState<ListenerForm>({
    address: initial?.address ?? '0.0.0.0',
    port:    initial?.port    ?? '',
    ssl:     initial?.ssl     ?? false,
    active:  initial?.active  ?? true,
    allowLegacyTls: initial?.allowLegacyTls ?? false,
  });
  const set = (f: keyof ListenerForm, v: string | boolean) => setForm(prev => ({ ...prev, [f]: v }));

  const titleId = useId();
  const addressId = useId();
  const portId = useId();
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40"
      className="bg-surface rounded-xl shadow-2xl w-full max-w-sm p-6"
    >
        <h3 id={titleId} className="text-base font-semibold text-fg mb-4">
          {initial ? 'Port bearbeiten' : 'Port hinzufügen'}
        </h3>
        <div className="space-y-3">
          <div>
            <label htmlFor={addressId} className="block text-xs font-medium text-fg-muted mb-1">IP-Adresse</label>
            <input id={addressId} type="text" value={form.address} onChange={e => set('address', e.target.value)}
              placeholder="0.0.0.0"
              className="w-full border border-line-strong rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg" />
            <p className="text-[11px] text-fg-subtle mt-1">0.0.0.0 = alle Schnittstellen. Eine feste IP muss auf dem Server existieren.</p>
          </div>
          <div>
            <label htmlFor={portId} className="block text-xs font-medium text-fg-muted mb-1">Port</label>
            <input id={portId} type="number" value={form.port} onChange={e => set('port', e.target.value)}
              placeholder="25" min={1} max={65535}
              className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg" />
            {smtp && (
              <p className="text-[11px] text-fg-subtle mt-1">Die Ports 465 und 587 sind Versand (mit Anmeldung), alle anderen SMTP-Ports nehmen Mail von anderen Servern an.</p>
            )}
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-xs font-medium text-fg-muted">SSL/TLS (implizit, z. B. 465/993/995) — aus = STARTTLS</span>
            <Toggle active={form.ssl} label="SSL/TLS" onToggle={() => set('ssl', !form.ssl)} />
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-xs font-medium text-fg-muted">Aktiv</span>
            <Toggle active={form.active} label="Aktiv" onToggle={() => set('active', !form.active)} />
          </div>
          <div className="py-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-fg-muted">{LEGACY_TLS_LABEL}</span>
              <Toggle active={form.allowLegacyTls} label={LEGACY_TLS_LABEL}
                onToggle={() => set('allowLegacyTls', !form.allowLegacyTls)} />
            </div>
            {form.allowLegacyTls ? <LegacyTlsWarning /> : <LegacyTlsHint />}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-fg-muted bg-surface-2 rounded-lg hover:bg-surface-3 transition-colors">
            Abbrechen
          </button>
          <button disabled={saving} onClick={() => {
            const port = Number(form.port);
            if (!Number.isInteger(port) || port < 1 || port > 65535) { toast.error('Bitte einen gültigen Port (1–65535) eingeben'); return; }
            if (!form.address.trim()) { toast.error('Bitte eine IP-Adresse eingeben (0.0.0.0 = alle)'); return; }
            onSave({ ...form, address: form.address.trim() });
          }} className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50">
            {saving ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
    </Modal>
  );
}

// ── Ports of one listener service ─────────────────────────────────────────────
function PortsTable({ ports, service, caption }: { ports: OverviewPort[]; service: ListenerService; caption: string }) {
  const invalidate = useInvalidateOverview();
  const [modal, setModal] = useState<'add' | string | null>(null);
  const editing = modal && modal !== 'add' ? ports.find(p => p.id === modal) : undefined;
  const smtp = service === 'SMTP_RECEIVE';

  const addMut = useMutation({
    mutationFn: (d: ListenerForm) => api.post(`/admin/services/listeners/${listenerSlug(service)}`, listenerPayload(d)),
    onSuccess: () => { invalidate(); setModal(null); toast.success('Port hinzugefügt'); },
    onError:   (e) => toast.error(`Fehler beim Hinzufügen: ${errorMessage(e)}`),
  });
  const editMut = useMutation({
    mutationFn: ({ id, d }: { id: string; d: ListenerForm }) => api.put(`/admin/services/listeners/${id}`, listenerPayload(d)),
    onSuccess: () => { invalidate(); setModal(null); toast.success('Gespeichert'); },
    onError:   (e) => toast.error(`Fehler beim Speichern: ${errorMessage(e)}`),
  });
  const toggleMut = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/services/listeners/${id}/toggle`, {}),
    onSuccess: () => invalidate(),
    onError:   (e) => toast.error(`Umschalten fehlgeschlagen: ${errorMessage(e)}`),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/services/listeners/${id}`),
    onSuccess: () => { invalidate(); toast.success('Gelöscht'); },
    onError:   (e) => toast.error(`Fehler beim Löschen: ${errorMessage(e)}`),
  });

  return (
    <div className="mt-3">
      {ports.length === 0 ? (
        <p className="text-xs text-fg-subtle">Kein Port eingerichtet.</p>
      ) : (
        <table className="w-full text-sm border border-line rounded">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="bg-surface-2 border-b border-line">
              <th scope="col" className="text-left px-3 py-1.5 text-xs font-medium text-fg-subtle">Adresse:Port</th>
              <th scope="col" className="text-left px-3 py-1.5 text-xs font-medium text-fg-subtle">TLS</th>
              <th scope="col" className="text-right px-3 py-1.5 text-xs font-medium text-fg-subtle">Port aktiv</th>
              <th scope="col" className="px-3 py-1.5"><span className="sr-only">Aktionen</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {ports.map((p) => (
              <tr key={p.id}>
                <td className="px-3 py-1.5 font-mono text-fg">{p.address}:{p.port}</td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-surface-2 text-fg-muted border border-line">
                      {p.tlsMode === 'tls' && <Lock size={10} aria-hidden="true" />}
                      {p.tlsMode === 'tls' ? 'TLS' : 'STARTTLS'}
                    </span>
                    {p.allowLegacyTls && <LegacyTlsBadge />}
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Can area="servers" access="write">
                    <Toggle active={p.active} label={`Port ${p.address}:${p.port} aktiv`}
                      disabled={toggleMut.isPending} onToggle={() => toggleMut.mutate(p.id)} />
                  </Can>
                </td>
                <td className="px-3 py-1.5">
                  <Can area="servers" access="write" mode="hide">
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" aria-label={`Port ${p.address}:${p.port} bearbeiten`} title="Bearbeiten" onClick={() => setModal(p.id)}
                        className="p-1.5 text-fg-subtle hover:text-info-fg hover:bg-info-bg rounded transition-colors border border-line">
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                      <button type="button" aria-label={`Port ${p.address}:${p.port} löschen`} title="Löschen"
                        onClick={() => { if (confirm(`Port ${p.address}:${p.port} löschen?`)) deleteMut.mutate(p.id); }}
                        className="p-1.5 text-fg-subtle hover:text-danger-fg hover:bg-danger-bg rounded transition-colors border border-line">
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </Can>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Can area="servers" access="write" mode="hide">
        <button type="button" onClick={() => setModal('add')} className="mt-2 flex items-center gap-1.5 text-xs text-accent-fg hover:underline">
          <Plus size={12} aria-hidden="true" /> Port hinzufügen
        </button>
      </Can>

      {modal === 'add' && <ListenerModal smtp={smtp} saving={addMut.isPending} onSave={d => addMut.mutate(d)} onClose={() => setModal(null)} />}
      {editing && (
        <ListenerModal
          smtp={smtp}
          initial={{ address: editing.address, port: String(editing.port), ssl: editing.ssl, active: editing.active, allowLegacyTls: editing.allowLegacyTls }}
          saving={editMut.isPending}
          onSave={d => editMut.mutate({ id: editing.id, d })}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ── Overriding domains / mailboxes ────────────────────────────────────────────
function OverrideList({ level, group }: { level: 'domains' | 'users'; group: OverrideGroup }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (group.total === 0) return null;
  const label = overrideSummary(level, group) ?? `${group.total} ${level === 'domains' ? 'Domain-Einstellung(en)' : 'Postfach-Einstellung(en)'} wie geerbt`;
  if (group.namesHidden) {
    return <p className="text-xs text-fg-muted">{label} <span className="text-fg-subtle">({hiddenNamesText(level)})</span></p>;
  }
  return (
    <div>
      <button type="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-accent-fg hover:underline">
        {open ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
        {label}
      </button>
      {open && (
        <ul id={listId} className="mt-1 ml-4 space-y-0.5 text-xs">
          {group.entries.map((e) => (
            <li key={e.id}>
              <Link to={overrideLink(level, e.name)} className="font-mono text-accent-fg hover:underline">{e.name}</Link>
              <span className="text-fg-subtle"> — {overrideEntryLabel(e)}</span>
            </li>
          ))}
          {group.total > group.entries.length && (
            <li className="text-fg-subtle">… und {group.total - group.entries.length} weitere</li>
          )}
        </ul>
      )}
    </div>
  );
}

// ── One protocol ──────────────────────────────────────────────────────────────
function ProtocolCard({ row, https }: { row: ProtocolOverviewRow; https: HttpsState }) {
  const qc = useQueryClient();
  const invalidate = useInvalidateOverview();
  const headingId = useId();
  const name = PROTOCOL_NAMES[row.protocol];
  const on = row.server === 'on';
  const save = useMutation({
    mutationFn: (next: 'on' | 'off') => api.put<ProtocolLevelView>('/admin/protocol-access', { [row.protocol]: next }),
    onSuccess: (view) => {
      qc.setQueryData(['protocol-access', '/admin/protocol-access'], view);
      invalidate();
      toast.success(`${name}: Zugriff gespeichert — betroffene Konten: ${view.changedUsers ?? 0}`);
    },
    onError: (e) => toast.error(`${name}: Zugriff konnte nicht gespeichert werden: ${errorMessage(e)}`),
  });
  const toggle = () => {
    if (on && row.protocol === 'webmail'
      && !confirm('Ohne Webmail können sich Konten ohne Administratorrolle nicht mehr im Webmail anmelden. Administratoren behalten den Zugang zur Verwaltung. Webmail serverweit ausschalten?')) return;
    save.mutate(on ? 'off' : 'on');
  };

  return (
    <section id={protocolAnchorId(row.protocol)} tabIndex={-1} aria-labelledby={headingId}
      className="bg-surface border border-line rounded-xl p-4 scroll-mt-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h3 id={headingId} className="text-sm font-semibold text-fg">{name}</h3>
          <p className="text-xs text-fg-subtle mt-0.5">{summaryLine(row, https)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-fg-muted">Zugriff serverweit: {on ? 'an' : 'aus'}</span>
          <Can area="servers" access="write">
            <Toggle active={on} label={`${name}: Zugriff serverweit`} disabled={save.isPending} onToggle={toggle} />
          </Can>
        </div>
      </div>
      <div className="mt-2 space-y-1">
        <OverrideList level="domains" group={row.overrides.domains} />
        <OverrideList level="users" group={row.overrides.users} />
      </div>
      {row.warnings.map((w) => <WarningLine key={w.code} warning={w} https={https} />)}
      {row.notices.map((n) => <NoticeLine key={n.code} notice={n} />)}
      {row.listenerService
        ? <PortsTable ports={row.ports} service={row.listenerService} caption={`${name}: Ports`} />
        : (
          <p className="mt-3 text-xs text-fg-subtle">
            Läuft über den HTTP-/HTTPS-Server, keine eigenen Ports. {httpsName(https.port)}: {https.active ? 'aktiv' : 'nicht aktiv'}.
          </p>
        )}
    </section>
  );
}

function WarningLine({ warning, https }: { warning: OverviewWarning; https: HttpsState }) {
  return (
    <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-warning-line bg-warning-bg px-3 py-2 text-xs text-warning-fg">
      <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span><span className="sr-only">Warnung: </span>{warningText(warning, https)}</span>
    </p>
  );
}

/** Softer than WarningLine: consistent, but worth knowing (port open, access only for overrides). */
function NoticeLine({ notice }: { notice: OverviewNotice }) {
  return (
    <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-info-line bg-info-bg px-3 py-2 text-xs text-info-fg">
      <Info size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span><span className="sr-only">Hinweis: </span>{noticeText(notice)}</span>
    </p>
  );
}

// ── Inbound transport (SMTP from other servers) ──────────────────────────────
function InboundCard({ ports }: { ports: OverviewPort[] }) {
  const headingId = useId();
  return (
    <section id={SMTP_INBOUND_ANCHOR} tabIndex={-1} aria-labelledby={headingId}
      className="bg-surface border border-line rounded-xl p-4 scroll-mt-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg">
      <div className="flex items-center gap-2">
        <Inbox size={14} className="text-fg-subtle" aria-hidden="true" />
        <h3 id={headingId} className="text-sm font-semibold text-fg">SMTP-Empfang (Transport)</h3>
      </div>
      <p className="text-xs text-fg-subtle mt-0.5">
        Mail von anderen Servern, z. B. Port 25. Kein Benutzerzugang: hier meldet sich niemand an, der Zugriffsschalter gilt dafür nicht.
      </p>
      <PortsTable ports={ports} service="SMTP_RECEIVE" caption="SMTP-Empfang: Ports" />
    </section>
  );
}

// ── HTTPS (Port 443): TLS policy ──────────────────────────────────────────────
function HttpsTlsCard({ https }: { https: HttpsState }) {
  const qc = useQueryClient();
  const { data } = useQuery<{ allowLegacyTls: boolean }>({
    queryKey: ['services-https-tls'],
    queryFn:  () => api.get<{ allowLegacyTls: boolean }>('/admin/services/https-tls'),
  });
  const mut = useMutation({
    mutationFn: (allowLegacyTls: boolean) => api.put('/admin/services/https-tls', { allowLegacyTls }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['services-https-tls'] }); toast.success('Gespeichert'); },
    onError:   (e) => toast.error(`Fehler beim Speichern: ${errorMessage(e)}`),
  });
  const on = data?.allowLegacyTls === true;
  const certText = https.cert
    ? `Zertifikat „${https.cert.name}“${https.cert.trusted ? '' : ' (nicht vertrauenswürdig)'}`
    : 'kein Zertifikat zugewiesen';
  return (
    <section className="bg-surface border border-line rounded-xl p-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="p-2 bg-info-bg rounded-lg"><Globe size={18} className="text-info-fg" aria-hidden="true" /></div>
        <div>
          <h3 className="text-sm font-semibold text-fg">Veraltete TLS-Versionen 1.0/1.1</h3>
          <p className="text-xs text-fg-subtle">
            {httpsName(https.port)}: Webmail, BCP, ActiveSync, JMAP, CalDAV/CardDAV, MAPI, Autodiscover — {certText}.{' '}
            <Link to="/certificates" className="text-accent-fg hover:underline">SSL/TLS öffnen</Link>
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3 shrink-0">
          {on && <LegacyTlsBadge />}
          <Can area="servers" access="write">
            <Toggle active={on} label={LEGACY_TLS_LABEL} disabled={!data || mut.isPending}
              onToggle={() => mut.mutate(!on)} />
          </Can>
        </div>
      </div>
      <p role="status" className={`mb-2 flex items-start gap-1.5 text-xs font-medium ${https.active ? 'text-success-fg' : 'text-warning-fg'}`}>
        {https.active
          ? <CheckCircle2 size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          : <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />}
        <span>{httpsStatusText(https.active, on)}</span>
      </p>
      {on ? <LegacyTlsWarning /> : <LegacyTlsHint />}
    </section>
  );
}

// ── Ports vs. access ──────────────────────────────────────────────────────────
function ExplanationBox() {
  return (
    <div className="bg-info-bg border border-info-line rounded-lg p-4 text-xs text-info-fg space-y-1.5">
      <p className="flex items-center gap-1.5 font-semibold"><Info size={13} aria-hidden="true" /> Ports und Zugriff</p>
      <p>
        <strong>Port</strong>: ob der Server auf einer Adresse lauscht — ist kein Port aktiv, kann sich kein Programm verbinden.
        Änderungen wirken sofort; ändern sich TLS, „veraltete TLS-Versionen 1.0/1.1 zulassen“ oder die Adresse eines laufenden Ports, wird nur
        dieser Port kurz neu gestartet (offene Verbindungen werden getrennt).
      </p>
      <p>
        <strong>Zugriff</strong>: ob ein Konto das Protokoll nach der Anmeldung nutzen darf. Hier gilt er serverweit;
        einzelne Domains (Domain bearbeiten) und Postfächer (Postfach bearbeiten) können abweichen. Ausschalten beendet
        laufende Verbindungen der betroffenen Konten sofort.
      </p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
/** Old sub-page links (/services/imap, /services/smtp-receive, …) → the combined page at the matching card. */
export function ServicesLegacyRedirect() {
  const { sub } = useParams();
  return <Navigate to={legacyServicesTarget(sub)} replace />;
}

/** Scrolls to and focuses the card named by the URL hash (/services#protocol-imap) once the page has loaded. */
function useAnchorFocus(ready: boolean): void {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || hash.length < 2) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
  }, [ready, hash]);
}

export function ServicesPage() {
  const t = useT();
  const { data, isLoading, isError } = useQuery<ProtocolOverview>({
    queryKey: OVERVIEW_KEY,
    queryFn:  () => api.get<ProtocolOverview>('/admin/protocol-access/overview'),
  });
  useAnchorFocus(data !== undefined);

  return (
    <div className="h-full overflow-y-auto bg-surface-2">
      <div className="p-6 max-w-4xl space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-fg">{t('nav_services')}</h2>
          <p className="text-sm text-fg-subtle mt-0.5">Ports und serverweiter Zugriff je Protokoll</p>
        </div>
        <ExplanationBox />
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-fg-subtle">
            <Loader2 size={18} className="animate-spin mr-2" aria-hidden="true" /> Lade…
          </div>
        ) : isError || !data ? (
          <p className="text-sm text-danger-fg">Die Protokolle konnten nicht geladen werden.</p>
        ) : (
          <>
            {data.warnings.length > 0 && (
              <div role="status" className="px-4 py-3 bg-warning-bg border border-warning-line rounded-xl text-sm text-warning-fg">
                <p className="flex items-center gap-2 font-semibold">
                  <AlertTriangle size={14} aria-hidden="true" /> {data.warnings.length === 1 ? '1 Unstimmigkeit' : `${data.warnings.length} Unstimmigkeiten`}
                </p>
                <ul className="mt-1 list-disc pl-5 text-xs space-y-0.5">
                  {data.warnings.map((w) => <li key={`${w.protocol}-${w.code}`}>{warningText(w, data.https)}</li>)}
                </ul>
              </div>
            )}
            {orderedRows(data).map((row) => <ProtocolCard key={row.protocol} row={row} https={data.https} />)}
            <InboundCard ports={data.smtpInbound.ports} />
            <HttpsTlsCard https={data.https} />
          </>
        )}
      </div>
    </div>
  );
}
