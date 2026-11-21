/**
 * 10.6: Settings → Sicherheit → Passkeys (docs/passkeys.md). Lists the
 * account's passkeys and security keys (name, synced / device-bound from the
 * BE / BS flags, provider, added, last used), adds a passkey (re-authentication
 * with the password or an existing passkey; hint that mail programs then need
 * app passwords), renames and removes them. Pre-10.6 security keys are marked
 * and can be registered again as a passkey. Also shown on the mandatory MFA
 * enrolment page (a passkey is a second factor).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, KeyRound, Loader2, Lock, Pencil, Trash2, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { Modal } from '../Modal.js';
import { useT, fmt } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';
import { ApiError } from '../../lib/errors.js';
import { useRegional } from '../../store/preferences.js';
import { formatDateTime } from '../../lib/regionalFormat.js';
import { needsSecondPasskeyHint, passkeyBrowserErrorKey, passkeyErrorKey, passkeyStorage, type PasskeyInfo } from '../../lib/passkeys.js';
import { webauthnAuthenticate, webauthnFailure, webauthnRegister, webauthnSupported } from '../../lib/webauthn.js';
import {
  listPasskeys, reauthOptions, registrationOptions, registrationVerify, removePasskey, renamePasskey, signalPasskeyState,
  type Reauth,
} from '../../api/passkeys.js';

/** Error of a passkey action → readable text in the UI language. */
function useErrorText() {
  const t = useT();
  return (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code && /^REAUTH_/.test(err.code)) return err.message;
      return t(passkeyErrorKey(err.code) as TranslationKey);
    }
    if (typeof err === 'object' && err !== null && 'name' in err) return t(passkeyBrowserErrorKey(webauthnFailure(err)) as TranslationKey);
    return t('pk_err_failed');
  };
}

interface ReauthRequest {
  title: string;
  confirmLabel: string;
  run: (r: Reauth) => Promise<void>;
}

/** Re-authentication with the current password or an existing passkey (module level: stable identity). */
function ReauthDialog({ req, withPassword, withPasskey, onClose }: {
  req: ReauthRequest; withPassword: boolean; withPasskey: boolean; onClose: () => void;
}) {
  const t = useT();
  const errorText = useErrorText();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (get: () => Promise<Reauth>) => {
    setBusy(true);
    setError('');
    try {
      await req.run(await get());
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (password) void run(async () => ({ currentPassword: password }));
  };
  const usePasskey = () => void run(async () => {
    const opts = await reauthOptions();
    const response = await webauthnAuthenticate(opts.publicKey);
    return { webauthnFlowId: opts.flowId, webauthnResponse: response };
  });

  return (
    <Modal onClose={onClose} labelledBy="pk-reauth-title" className="bg-surface rounded-lg shadow-2xl w-full max-w-sm p-5">
      <form onSubmit={submitPassword} className="space-y-3">
        <h2 id="pk-reauth-title" className="text-base font-semibold text-fg flex items-center gap-2">
          <Lock size={15} aria-hidden="true" /> {req.title}
        </h2>
        <p className="text-xs text-fg-subtle">{withPassword ? t('pk_reauth_text') : t('pk_reauth_passkey_only')}</p>
        {withPassword && (
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            aria-label={t('pk_password_label')}
            placeholder={t('pk_password_label')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
        )}
        {withPasskey && (
          <button type="button" onClick={usePasskey} disabled={busy} className="btn-secondary text-xs inline-flex items-center gap-1.5 disabled:opacity-50">
            <KeyRound size={12} aria-hidden="true" /> {t('pk_reauth_with_passkey')}
          </button>
        )}
        {error && <p role="alert" className="text-xs text-danger-fg">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary text-xs">{t('pk_cancel')}</button>
          {withPassword && (
            <button type="submit" disabled={busy || !password} className="btn-primary text-xs inline-flex items-center gap-1.5 disabled:opacity-50">
              {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />} {req.confirmLabel}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function PasskeyRow({ p, onRename, onRemove, onReRegister }: {
  p: PasskeyInfo; onRename: (p: PasskeyInfo) => void; onRemove: (p: PasskeyInfo) => void; onReRegister: () => void;
}) {
  const t = useT();
  const regional = useRegional();
  const when = (iso: string) => formatDateTime(new Date(iso), regional);
  const storage = passkeyStorage(p);
  const kindText = p.kind === 'passkey'
    ? (storage === 'synced' ? t('pk_synced') : storage === 'device' ? t('pk_device') : t('pk_storage_unknown'))
    : (p.legacy ? t('pk_legacy') : t('pk_security_key'));
  return (
    <li className="flex items-start gap-3 py-2">
      {p.kind === 'passkey'
        ? <Fingerprint size={16} className="mt-0.5 text-fg-subtle shrink-0" aria-hidden="true" />
        : <KeyRound size={16} className="mt-0.5 text-fg-subtle shrink-0" aria-hidden="true" />}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-fg truncate">{p.name}</p>
        <p className="text-xs text-fg-subtle">
          {kindText}{p.provider ? ` · ${p.provider}` : ''}
        </p>
        <p className="text-xs text-fg-subtle">
          {fmt(t('pk_created'), { date: when(p.createdAt) })} · {p.lastUsedAt ? fmt(t('pk_last_used'), { date: when(p.lastUsedAt) }) : t('pk_never_used')}
        </p>
        {p.legacy && (
          <button type="button" onClick={onReRegister} className="mt-1 text-xs text-accent-fg hover:underline">
            {t('pk_add_again')}
          </button>
        )}
      </div>
      <div className="flex gap-1 shrink-0">
        <button type="button" onClick={() => onRename(p)} aria-label={`${t('pk_rename')}: ${p.name}`} title={t('pk_rename')}
          className="p-1.5 rounded text-fg-subtle hover:bg-surface-3 hover:text-fg">
          <Pencil size={13} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => onRemove(p)} aria-label={`${t('pk_remove')}: ${p.name}`} title={t('pk_remove')}
          className="p-1.5 rounded text-danger-fg hover:bg-danger-bg">
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

function RenameDialog({ p, onClose }: { p: PasskeyInfo; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [name, setName] = useState(p.name);
  const [error, setError] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await renamePasskey(p.id, name.trim() || p.name);
      toast.success(t('pk_renamed'));
      void qc.invalidateQueries({ queryKey: ['passkeys'] });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal onClose={onClose} labelledBy="pk-rename-title" className="bg-surface rounded-lg shadow-2xl w-full max-w-sm p-5">
      <form onSubmit={save} className="space-y-3">
        <h2 id="pk-rename-title" className="text-base font-semibold text-fg">{t('pk_rename')}</h2>
        <input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} aria-label={t('pk_name_label')} className="input" />
        {error && <p role="alert" className="text-xs text-danger-fg">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary text-xs">{t('pk_cancel')}</button>
          <button type="submit" className="btn-primary text-xs">{t('pk_confirm')}</button>
        </div>
      </form>
    </Modal>
  );
}

interface MfaStatusLike { totpEnabled?: boolean; webauthnCount?: number }

export function PasskeysPanel({ enrolmentOnly = false }: { enrolmentOnly?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['passkeys'], queryFn: listPasskeys, staleTime: 0 });
  const [name, setName] = useState('');
  const [reauth, setReauth] = useState<ReauthRequest | null>(null);
  const [renaming, setRenaming] = useState<PasskeyInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [appPasswordHint, setAppPasswordHint] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['passkeys'] });
    void qc.invalidateQueries({ queryKey: ['mfa-status'] });
    void qc.invalidateQueries({ queryKey: ['mfa-enforcement'] });
  };

  const add = () => {
    const before = qc.getQueryData<MfaStatusLike>(['mfa-status']);
    const hadFactor = !!before && (before.totpEnabled === true || (before.webauthnCount ?? 0) > 0);
    setReauth({
      title: t('pk_add_title'),
      confirmLabel: t('pk_add'),
      run: async (r) => {
        setBusy(true);
        try {
          const opts = await registrationOptions(r);
          const response = await webauthnRegister(opts.publicKey);
          await registrationVerify(opts.flowId, response, name.trim() || t('pk_default_name'));
          toast.success(t('pk_added'));
          setName('');
          if (!hadFactor) setAppPasswordHint(true);
          refresh();
          signalPasskeyState();
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const remove = (p: PasskeyInfo) => setReauth({
    title: t('pk_remove_title'),
    confirmLabel: t('pk_remove'),
    run: async (r) => {
      await removePasskey(p.id, r);
      toast.success(t('pk_removed'));
      refresh();
      signalPasskeyState();
    },
  });

  if (!webauthnSupported()) {
    return (
      <section className="bg-surface-2 border border-line rounded-lg p-4" aria-labelledby="pk-title">
        <h3 id="pk-title" className="text-sm font-medium flex items-center gap-2"><Fingerprint size={15} aria-hidden="true" />{t('pk_title')}</h3>
        <p className="text-xs text-warning-fg mt-2">{t('pk_unsupported')}</p>
      </section>
    );
  }

  const passkeys = data?.passkeys ?? [];
  const hasPasskey = passkeys.some((p) => p.kind === 'passkey');
  const canAdd = !!data && data.allowed && data.eligible;

  return (
    <section className="bg-surface-2 border border-line rounded-lg p-4 space-y-3" aria-labelledby="pk-title">
      <div className="flex items-center justify-between">
        <h3 id="pk-title" className="text-sm font-medium flex items-center gap-2">
          <Fingerprint size={15} className="text-fg-subtle" aria-hidden="true" />{t('pk_title')}
        </h3>
        {isLoading
          ? <Loader2 size={14} className="animate-spin text-fg-subtle" aria-hidden="true" />
          : <span className="text-xs font-medium text-fg-muted bg-surface-3 px-2 py-0.5 rounded-full">{fmt(t('pk_count'), { n: passkeys.length })}</span>}
      </div>
      <p className="text-xs text-fg-subtle">{t('pk_intro')}</p>
      {data?.passwordLoginDisabled && <p className="text-xs text-info-fg">{t('pk_passkey_only')}</p>}
      {data && !data.eligible && <p className="text-xs text-warning-fg">{t('pk_sso_account')}</p>}
      {data && data.eligible && !data.allowed && <p className="text-xs text-fg-muted">{t('pk_disabled')}</p>}
      {data && data.allowed && !data.ready && <p className="text-xs text-warning-fg">{t('pk_not_ready')}</p>}

      {passkeys.length > 0 ? (
        <ul className="divide-y divide-line" aria-label={t('pk_title')}>
          {passkeys.map((p) => (
            <PasskeyRow key={p.id} p={p} onRename={setRenaming} onRemove={remove} onReRegister={add} />
          ))}
        </ul>
      ) : (!isLoading && <p className="text-xs text-fg-subtle">{t('pk_empty')}</p>)}

      {needsSecondPasskeyHint(passkeys) && (
        <p className="text-xs text-fg-muted flex items-start gap-1.5"><Info size={12} className="mt-0.5 shrink-0" aria-hidden="true" />{t('pk_second_hint')}</p>
      )}

      {canAdd && (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 100))}
            aria-label={t('pk_name_label')}
            placeholder={t('pk_name_placeholder')}
            className="input text-xs flex-1 min-w-[160px]"
          />
          <button type="button" onClick={add} disabled={busy} className="btn-primary text-xs inline-flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Fingerprint size={12} aria-hidden="true" />}
            {t('pk_add')}
          </button>
        </div>
      )}

      {appPasswordHint && (
        <p role="status" className="text-xs rounded border border-info-line bg-info-bg text-info-fg px-3 py-2">
          {t('pk_app_password_hint')}{' '}
          {!enrolmentOnly && <Link to="/settings#appPasswords" className="underline">{t('pk_app_password_link')}</Link>}
        </p>
      )}

      {reauth && (
        <ReauthDialog
          req={reauth}
          withPassword={!data?.passwordLoginDisabled}
          withPasskey={hasPasskey}
          onClose={() => setReauth(null)}
        />
      )}
      {renaming && <RenameDialog p={renaming} onClose={() => setRenaming(null)} />}
    </section>
  );
}
