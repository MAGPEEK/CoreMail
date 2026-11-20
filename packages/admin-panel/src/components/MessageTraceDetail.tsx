/**
 * Message trace detail (10.2) — side panel of "Nachrichtenablaufverfolgung"
 * (EditPanel): Übersicht, Verarbeitung auf CoreMail (timeline of the recorded
 * stages), Zustellweg (Received chain of the stored original / CoreMail → MX).
 * Everything is rendered as React text — header values are never HTML.
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Lock, LockOpen, ArrowDown, AlertTriangle } from 'lucide-react';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';
import { translations, type TranslationKey } from '../i18n/translations.js';
import { useLanguageStore } from '../store/language.js';
import { EditPanel } from './EditPanel.js';
import {
  RESULT_TONE, resultOf, stageLabelKey, detailLabelKey, valueLabelKey, detailEntries, stageTls,
  formatDuration, formatBytes, plainValue, overviewOf, hasFewerDetails, timeOfDay, dateTime,
  type TraceDetail, type TraceStage, type TraceEntry, type ReceivedHop, type OutboundHop, type DetailValue, type AuthSummary,
} from '../lib/messageTrace.js';

type T = ReturnType<typeof useT>;
type Lang = 'de' | 'en';

const isKey = (k: string): k is TranslationKey => k in translations.de;
/** Translation of a dynamic key, or the fallback when the key does not exist. */
const tk = (t: T, key: string, fallback: string): string => (isKey(key) ? t(key) : fallback);

/** Renders a MAIL_FLOW status (the page's own badge, so table and panel read the same). */
type StatusView = (status: string) => ReactNode;

export function MessageTraceDetail({ id, onClose, onOpen, renderStatus }: {
  id: string;
  onClose: () => void;
  /** Opens another (related) entry in the panel. */
  onOpen: (id: string) => void;
  renderStatus: StatusView;
}) {
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const { data, isLoading, isError } = useQuery<TraceDetail>({
    queryKey: ['message-trace-detail', id],
    queryFn: () => api.get(`/admin/message-trace/${encodeURIComponent(id)}`),
  });

  const state = isLoading
    ? <p className="flex items-center gap-2 text-sm text-fg-subtle"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('mt_loading')}</p>
    : isError || !data
      ? <p role="alert" className="text-sm text-danger-fg">{t('mt_load_error')}</p>
      : null;

  const subject = data ? overviewOf(data.entry).subject : '';
  const tabs = [
    { id: 'overview', label: t('mt_tab_overview'), content: state ?? <OverviewTab d={data!} t={t} lang={lang} onOpen={onOpen} renderStatus={renderStatus} /> },
    { id: 'processing', label: t('mt_tab_processing'), content: state ?? <ProcessingTab d={data!} t={t} lang={lang} /> },
    { id: 'path', label: t('mt_tab_path'), content: state ?? <PathTab d={data!} t={t} lang={lang} /> },
  ];
  return (
    <EditPanel kind="message-trace" title={t('mt_detail_title')} subtitle={subject || (data ? t('mt_no_subject') : '')}
      tabs={tabs} onClose={onClose} />
  );
}

// ── Building blocks ───────────────────────────────────────────────────────────

function ResultBadge({ result, t }: { result: unknown; t: T }) {
  const r = resultOf(result);
  return <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium ${RESULT_TONE[r]}`}>{t(`mt_result_${r}` as TranslationKey)}</span>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-x-3 gap-y-0.5 py-1.5 border-b border-line last:border-b-0">
      <dt className="text-xs font-medium text-fg-muted">{label}</dt>
      <dd className="text-sm text-fg break-words min-w-0">{children}</dd>
    </div>
  );
}

function OlderNote({ t }: { t: T }) {
  return (
    <p className="flex items-start gap-2 text-xs text-fg-subtle bg-surface-2 rounded px-3 py-2">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />{t('mt_older_entry')}
    </p>
  );
}

function valueText(t: T, lang: Lang, key: string, value: DetailValue): string {
  if (typeof value === 'boolean') return value ? t('mt_yes') : t('mt_no');
  const vk = valueLabelKey(key, value);
  return vk && isKey(vk) ? t(vk) : plainValue(key, value, lang);
}

function TlsLine({ tls, t }: { tls: { encrypted: boolean; text: string }; t: T }) {
  const Icon = tls.encrypted ? Lock : LockOpen;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${tls.encrypted ? 'text-success-fg' : 'text-warning-fg'}`}>
      <Icon size={12} aria-hidden="true" />
      {tls.encrypted ? (tls.text || t('mt_with_tls')) : t('mt_without_tls')}
    </span>
  );
}

// ── Übersicht ─────────────────────────────────────────────────────────────────

function OverviewTab({ d, t, lang, onOpen, renderStatus }: { d: TraceDetail; t: T; lang: Lang; onOpen: (id: string) => void; renderStatus: StatusView }) {
  const o = overviewOf(d.entry);
  return (
    <div className="space-y-4">
      {hasFewerDetails(d) && <OlderNote t={t} />}
      <dl>
        <Field label={t('mt_direction')}>{t(`mt_dir_${d.direction}` as TranslationKey)}</Field>
        <Field label={t('mt_time')}>{dateTime(d.entry.timestamp, lang)}</Field>
        <Field label={t('mt_status')}>
          <span className="inline-flex flex-wrap items-center gap-2">
            {renderStatus(o.status)}
            {o.attempt && <span className="text-xs text-fg-subtle">{t('mt_attempt')} {o.attempt}</span>}
          </span>
        </Field>
        <Field label={t('mt_sender')}>{o.sender || '–'}</Field>
        <Field label={t('mt_recipients')}>
          {o.recipients.length ? <ul className="space-y-0.5">{o.recipients.map((r) => <li key={r}>{r}</li>)}</ul> : '–'}
        </Field>
        <Field label={t('mt_subject')}>{o.subject || t('mt_no_subject')}</Field>
        {o.messageId && <Field label={t('mt_message_id')}><span className="font-mono text-xs">{o.messageId}</span></Field>}
        {o.size !== null && <Field label={t('mt_size')}>{formatBytes(o.size, lang)}</Field>}
        {o.spamScore && <Field label={t('mt_spam_score')}>{o.spamScore}</Field>}
        {o.reason && <Field label={t('mt_reason')}><span className="text-danger-fg">{o.reason}</span></Field>}
      </dl>
      <section aria-labelledby="mt-related">
        <h3 id="mt-related" className="text-sm font-semibold text-fg">{t('mt_related')}</h3>
        <p className="text-xs text-fg-subtle mb-2">{t('mt_related_hint')}</p>
        {d.related.length === 0
          ? <p className="text-sm text-fg-subtle">{t('mt_related_none')}</p>
          : <ul className="divide-y divide-line border border-line rounded">{d.related.map((r) => <RelatedItem key={r.id} r={r} t={t} lang={lang} onOpen={onOpen} renderStatus={renderStatus} />)}</ul>}
      </section>
    </div>
  );
}

function RelatedItem({ r, t, lang, onOpen, renderStatus }: { r: TraceEntry; t: T; lang: Lang; onOpen: (id: string) => void; renderStatus: StatusView }) {
  const o = overviewOf(r);
  return (
    <li>
      <button type="button" onClick={() => onOpen(r.id)}
        className="w-full text-left px-3 py-2 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-fg">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="text-fg-subtle text-xs whitespace-nowrap">{dateTime(r.timestamp, lang)}</span>
          {renderStatus(o.status)}
          {o.attempt && <span className="text-xs text-fg-subtle">{t('mt_attempt')} {o.attempt}</span>}
        </span>
        <span className="block text-xs text-fg-muted break-words">{o.recipients.join(', ')}</span>
        {o.reason && <span className="block text-xs text-danger-fg break-words">{o.reason}</span>}
      </button>
    </li>
  );
}

// ── Verarbeitung auf CoreMail ─────────────────────────────────────────────────

function ProcessingTab({ d, t, lang }: { d: TraceDetail; t: T; lang: Lang }) {
  const stages = d.trace?.stages ?? [];
  if (stages.length === 0) {
    return <div className="space-y-3"><OlderNote t={t} /><p className="text-sm text-fg-subtle">{t('mt_no_stages')}</p></div>;
  }
  return (
    <ol className="relative border-l border-line ml-2 space-y-4">
      {stages.map((s, i) => <StageItem key={`${s.stage}-${i}`} s={s} t={t} lang={lang} />)}
    </ol>
  );
}

const DOT: Readonly<Record<string, string>> = { ok: 'bg-success', warn: 'bg-warning', fail: 'bg-danger', info: 'bg-line-strong' };

function StageItem({ s, t, lang }: { s: TraceStage; t: T; lang: Lang }) {
  const tls = stageTls(s);
  const entries = detailEntries(s);
  return (
    <li className="ml-4">
      <span aria-hidden="true" className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${DOT[resultOf(s.result)]}`} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs text-fg-subtle tabular-nums">{timeOfDay(s.at, lang)}</span>
        <span className="text-sm font-medium text-fg">{tk(t, stageLabelKey(s.stage), s.stage)}</span>
        <ResultBadge result={s.result} t={t} />
        {s.ms !== undefined && <span className="text-xs text-fg-subtle">{t('mt_duration')} {formatDuration(s.ms, lang)}</span>}
      </div>
      {(tls || entries.length > 0) && (
        <dl className="mt-1 grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-x-3 gap-y-0.5 text-xs">
          {tls && (
            <>
              <dt className="text-fg-muted">TLS</dt>
              <dd className="min-w-0 break-words"><TlsLine tls={tls} t={t} /></dd>
            </>
          )}
          {entries.map(([k, v]) => (
            <DetailRow key={k} label={tk(t, detailLabelKey(k), k)} value={valueText(t, lang, k, v)} />
          ))}
        </dl>
      )}
    </li>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="text-fg min-w-0 break-words">{value}</dd>
    </>
  );
}

// ── Zustellweg (Hops) ─────────────────────────────────────────────────────────

function PathTab({ d, t, lang }: { d: TraceDetail; t: T; lang: Lang }) {
  const p = d.path;
  if (p.kind === 'none') {
    return (
      <div className="space-y-3">
        {hasFewerDetails(d) && <OlderNote t={t} />}
        <p className="text-sm text-fg-subtle">{t(`mt_path_none_${p.reason.replace(/-/g, '_')}` as TranslationKey)}</p>
      </div>
    );
  }
  if (p.kind === 'outbound') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-fg-subtle">{t('mt_path_outbound_intro')}</p>
        <ol className="space-y-2">{p.hops.map((h, i) => <OutboundHopItem key={`${h.time}-${i}`} h={h} t={t} lang={lang} />)}</ol>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-subtle">{t('mt_path_received_intro')}</p>
      {p.hops.length === 0
        ? <p className="text-sm text-fg-subtle">{t('mt_path_no_received')}</p>
        : <ol className="space-y-1">{p.hops.map((h, i) => <ReceivedHopItem key={i} h={h} n={i + 1} first={i === 0} t={t} lang={lang} />)}</ol>}
      <AuthSummaryView auth={p.auth} t={t} />
    </div>
  );
}

function ReceivedHopItem({ h, n, first, t, lang }: { h: ReceivedHop; n: number; first: boolean; t: T; lang: Lang }) {
  return (
    <li>
      {!first && (
        <div className="flex items-center gap-2 pl-3 py-1 text-xs text-fg-subtle">
          <ArrowDown size={12} aria-hidden="true" />
          {h.delayMs !== undefined && (
            <span>{t('mt_hop_delay')} {formatDuration(h.delayMs, lang)}{h.delayMs < 0 ? ` (${t('mt_hop_clock_skew')})` : ''}</span>
          )}
        </div>
      )}
      <div className="border border-line rounded px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1">
          <span className="text-xs font-semibold text-fg-muted">{t('mt_hop')} {n}</span>
          <span className="text-xs text-fg-subtle">{h.time ? dateTime(h.time, lang) : t('mt_hop_no_time')}</span>
          {!h.raw && <TlsLine tls={{ encrypted: h.tls, text: [h.tlsVersion, h.tlsCipher].filter(Boolean).join(' · ') }} t={t} />}
        </div>
        {h.raw
          ? <Field label={t('mt_hop_raw')}><span className="font-mono text-xs">{h.raw}</span></Field>
          : (
            <dl>
              {h.from && <Field label={t('mt_hop_from')}>{h.from}</Field>}
              {h.fromRdns && <Field label={t('mt_hop_rdns')}>{h.fromRdns}</Field>}
              {h.fromIp && <Field label={t('mt_hop_ip')}><span className="font-mono text-xs">{h.fromIp}</span></Field>}
              {h.by && <Field label={t('mt_hop_by')}>{h.by}</Field>}
              {h.with && <Field label={t('mt_hop_with')}>{h.with}</Field>}
              {h.id && <Field label={t('mt_hop_id')}><span className="font-mono text-xs">{h.id}</span></Field>}
              {h.for && <Field label={t('mt_hop_for')}>{h.for}</Field>}
            </dl>
          )}
      </div>
    </li>
  );
}

function OutboundHopItem({ h, t, lang }: { h: OutboundHop; t: T; lang: Lang }) {
  return (
    <li className="border border-line rounded px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1">
        <span className="text-xs text-fg-subtle">{dateTime(h.time, lang)}</span>
        <ResultBadge result={h.result} t={t} />
        {h.ms !== undefined && <span className="text-xs text-fg-subtle">{t('mt_duration')} {formatDuration(h.ms, lang)}</span>}
        <TlsLine tls={{ encrypted: h.tls, text: h.tlsMode === 'starttls' ? 'STARTTLS' : h.tlsMode === 'implicit' ? 'TLS' : '' }} t={t} />
      </div>
      <dl>
        <Field label={t('mt_hop_from')}>{h.from}</Field>
        <Field label={t('mt_hop_by')}>{h.to}{h.domain ? ` (${h.domain})` : ''}</Field>
        {h.address && <Field label={t('mt_hop_ip')}><span className="font-mono text-xs">{h.address}{h.port ? `:${h.port}` : ''}</span></Field>}
        {(h.code !== undefined || h.response) && <Field label={t('mt_hop_reply')}><span className="font-mono text-xs">{h.response ?? h.code}</span></Field>}
      </dl>
    </li>
  );
}

function AuthSummaryView({ auth, t }: { auth: AuthSummary; t: T }) {
  if (auth.authResults.length === 0 && auth.arcSeals.length === 0) return null;
  return (
    <section aria-labelledby="mt-auth" className="space-y-2">
      <h3 id="mt-auth" className="text-sm font-semibold text-fg">{t('mt_auth_title')}</h3>
      <ul className="space-y-2">
        {auth.authResults.map((a, i) => (
          <li key={i} className="border border-line rounded px-3 py-2 text-xs">
            <p className="text-fg-muted mb-1">{a.source} · {t('mt_auth_by')} <span className="font-mono">{a.authservId || '–'}</span></p>
            <ul className="flex flex-wrap gap-1.5">
              {a.results.map((r, j) => (
                <li key={j} className={`px-2 py-0.5 rounded ${RESULT_TONE[r.result === 'pass' ? 'ok' : r.result === 'fail' || r.result === 'permerror' ? 'fail' : r.result === 'none' ? 'info' : 'warn']}`}>
                  {r.method}={r.result}{r.domain ? ` (${r.domain})` : ''}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {auth.arcSeals.length > 0 && (
        <p className="text-xs text-fg-muted">
          {t('mt_arc_seals')}: {auth.arcSeals.map((s) => `i=${s.instance} cv=${s.cv}${s.domain ? ` (${s.domain})` : ''}`).join(', ')}
        </p>
      )}
    </section>
  );
}
