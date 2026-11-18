/**
 * 9.4: editor of the webmail policy of one level (server, domain or mailbox),
 * built like the protocol-access editor: per module Erben | An | Aus (server:
 * An | Aus), then the attachment / content values. Every row shows the
 * effective value and where it comes from ("Grund"). Saving sends only what
 * changed.
 */
import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, LayoutGrid } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { WriteGuard } from './Can.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import type { AdminArea } from '../lib/adminAreas.js';
import { errorMessage } from '../lib/errors.js';
import { effectiveOf, settingsForLevel, type ProtocolSetting } from '../lib/protocolAccess.js';
import {
  EXTERNAL_IMAGE_MODES, draftFromView, formatExtensions, isEmptyPatch, patchFromDraft,
  type ContentKey, type ExternalImageMode, type PolicyDraft, type ValueSource, type WebmailFeature,
  type WebmailPolicyView,
} from '../lib/webmailPolicies.js';

const FEATURE_KEYS: Record<WebmailFeature, TranslationKey> = {
  calendar: 'wp_feature_calendar', contacts: 'wp_feature_contacts', tasks: 'wp_feature_tasks', notes: 'wp_feature_notes',
  rules: 'wp_feature_rules', signatures: 'wp_feature_signatures', categories: 'wp_feature_categories',
  recoverItems: 'wp_feature_recoverItems', changePassword: 'wp_feature_changePassword', themes: 'wp_feature_themes',
  externalClients: 'wp_feature_externalClients', appPasswords: 'wp_feature_appPasswords', sharedMailboxes: 'wp_feature_sharedMailboxes',
};
const SOURCE_KEYS: Record<ValueSource, TranslationKey> = {
  default: 'wp_source_default', global: 'wp_source_global', domain: 'wp_source_domain', user: 'wp_source_user',
};
const IMAGE_KEYS: Record<ExternalImageMode, TranslationKey> = {
  ask: 'wp_images_ask', contacts: 'wp_images_contacts', block: 'wp_images_block',
};
const HINT_KEYS: Record<WebmailPolicyView['level'], TranslationKey> = {
  global: 'wp_hint_global', domain: 'wp_hint_domain', user: 'wp_hint_user',
};

const cell = 'px-3 py-1.5';
const head = 'text-left px-3 py-1.5 text-xs font-medium text-fg-subtle';

function StateBadge({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${on ? 'bg-success-bg text-success-fg' : 'bg-surface-2 text-fg-subtle'}`}>
      {label}
    </span>
  );
}

export function WebmailPolicyEditor({ path, area }: {
  /** API path of the level, e.g. /admin/webmail-policies/domains/<id>. */
  path: string;
  /** Area whose write access the level needs (servers, recipients). */
  area: AdminArea;
}) {
  const t = useT();
  const qc = useQueryClient();
  const headingId = useId();
  const { data: view, isLoading, isError } = useQuery<WebmailPolicyView>({
    queryKey: ['webmail-policies', path],
    queryFn: () => api.get<WebmailPolicyView>(path),
  });
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  useEffect(() => { if (view) setDraft(draftFromView(view)); }, [view]);

  const save = useMutation({
    mutationFn: (body: object) => api.put<WebmailPolicyView>(path, body),
    onSuccess: (next) => {
      qc.setQueryData(['webmail-policies', path], next);
      toast.success(`${t('wp_saved')} — ${t('wp_saved_users')}: ${next.users ?? 0}`);
    },
    onError: (e) => toast.error(`${t('wp_save_error')}: ${errorMessage(e)}`),
  });

  if (isLoading) {
    return <div className="flex items-center gap-2 text-xs text-fg-subtle"><Loader2 size={14} className="animate-spin" /> {t('wp_title')}</div>;
  }
  if (isError || !view || !draft) return <p className="text-xs text-danger-fg">{t('wp_load_error')}</p>;

  const result = patchFromDraft(view, draft);
  const dirty = !result.ok || !isEmptyPatch(result.patch);
  const global = view.level === 'global';
  const state = (on: boolean) => (on ? t('proto_state_on') : t('proto_state_off'));
  const reason = (s: ValueSource) => t(SOURCE_KEYS[s]);
  const optionLabel = (s: ProtocolSetting, f: WebmailFeature): string =>
    s === 'inherit' ? `${t('proto_setting_inherit')} (${state(view.inherited.features[f])})` : s === 'on' ? t('proto_setting_on') : t('proto_setting_off');
  const listText = (list: string[]) => (list.length ? formatExtensions(list) : t('wp_none'));
  const effectiveText: Record<ContentKey, string> = {
    blockedExtensions: listText(view.effective.content.blockedExtensions),
    downloadOnlyExtensions: listText(view.effective.content.downloadOnlyExtensions),
    maxUploadMb: view.effective.content.maxUploadMb === null ? t('wp_upload_unlimited') : `${view.effective.content.maxUploadMb} MB`,
    externalImages: t(IMAGE_KEYS[view.effective.content.externalImages]),
  };

  const listRow = (key: 'blockedExtensions' | 'downloadOnlyExtensions', label: TranslationKey, hint: TranslationKey) => (
    <tr key={key}>
      <th scope="row" className={`${cell} text-left font-normal text-fg align-top`}>
        {t(label)}
        <p className="text-[11px] text-fg-subtle">{t(hint)}</p>
      </th>
      <td className={`${cell} align-top`}>
        {!global && (
          <label className="flex items-center gap-1.5 text-xs text-fg-muted mb-1">
            <input type="checkbox" checked={draft[key].inherit}
              onChange={(e) => setDraft({ ...draft, [key]: { ...draft[key], inherit: e.target.checked } })} />
            {t('proto_setting_inherit')}
          </label>
        )}
        <input type="text" aria-label={t(label)} value={draft[key].text} disabled={draft[key].inherit}
          placeholder="exe, js, bat"
          onChange={(e) => setDraft({ ...draft, [key]: { inherit: false, text: e.target.value } })}
          className="input py-1 w-full disabled:opacity-60" />
      </td>
      <td className={`${cell} text-right text-xs text-fg-muted align-top`}>{effectiveText[key]}</td>
      <td className={`${cell} text-right text-xs text-fg-subtle align-top`}>{reason(view.sources.content[key])}</td>
    </tr>
  );

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex items-center gap-2">
        <LayoutGrid size={14} className="text-fg-subtle" aria-hidden="true" />
        <h3 id={headingId} className="text-xs font-semibold text-fg-muted uppercase tracking-wide">{t('wp_title')}</h3>
      </div>
      <p className="text-xs text-fg-subtle">{t(HINT_KEYS[view.level])}</p>
      <WriteGuard area={area}>
        <table className="w-full text-sm border border-line rounded">
          <thead>
            <tr className="bg-surface-2 border-b border-line">
              <th scope="col" className={head}>{t('wp_col_feature')}</th>
              <th scope="col" className={head}>{t('proto_col_setting')}</th>
              <th scope="col" className={`${head} text-right`}>{t('proto_col_effective')}</th>
              <th scope="col" className={`${head} text-right`}>{t('wp_col_reason')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {view.features.map((f) => {
              const on = effectiveOf(draft.features[f], view.inherited.features[f]);
              return (
                <tr key={f}>
                  <th scope="row" className={`${cell} text-left font-normal text-fg`}>{t(FEATURE_KEYS[f])}</th>
                  <td className={cell}>
                    <select aria-label={`${t(FEATURE_KEYS[f])}: ${t('proto_col_setting')}`} value={draft.features[f]}
                      onChange={(e) => setDraft({ ...draft, features: { ...draft.features, [f]: e.target.value as ProtocolSetting } })}
                      className="input w-auto py-1">
                      {settingsForLevel(view.level).map((s) => <option key={s} value={s}>{optionLabel(s, f)}</option>)}
                    </select>
                  </td>
                  <td className={`${cell} text-right`}><StateBadge on={on} label={state(on)} /></td>
                  <td className={`${cell} text-right text-xs text-fg-subtle`}>{reason(view.sources.features[f])}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h4 className="mt-4 text-xs font-semibold text-fg-muted uppercase tracking-wide">{t('wp_content_title')}</h4>
        <table className="w-full text-sm border border-line rounded mt-2">
          <thead>
            <tr className="bg-surface-2 border-b border-line">
              <th scope="col" className={head}>{t('wp_col_value')}</th>
              <th scope="col" className={head}>{t('proto_col_setting')}</th>
              <th scope="col" className={`${head} text-right`}>{t('proto_col_effective')}</th>
              <th scope="col" className={`${head} text-right`}>{t('wp_col_reason')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {listRow('blockedExtensions', 'wp_blocked', 'wp_blocked_hint')}
            {listRow('downloadOnlyExtensions', 'wp_save_only', 'wp_save_only_hint')}
            <tr>
              <th scope="row" className={`${cell} text-left font-normal text-fg align-top`}>
                {t('wp_upload')}
                <p className="text-[11px] text-fg-subtle">{t(global ? 'wp_upload_hint_global' : 'wp_upload_hint')}</p>
              </th>
              <td className={`${cell} align-top`}>
                {!global && (
                  <label className="flex items-center gap-1.5 text-xs text-fg-muted mb-1">
                    <input type="checkbox" checked={draft.maxUploadMb.inherit}
                      onChange={(e) => setDraft({ ...draft, maxUploadMb: { ...draft.maxUploadMb, inherit: e.target.checked } })} />
                    {t('proto_setting_inherit')}
                  </label>
                )}
                <input type="number" min={1} aria-label={t('wp_upload')} value={draft.maxUploadMb.text} disabled={draft.maxUploadMb.inherit}
                  onChange={(e) => setDraft({ ...draft, maxUploadMb: { inherit: false, text: e.target.value } })}
                  className="input py-1 w-28 disabled:opacity-60" />
                {!result.ok && <p className="text-[11px] text-danger-fg mt-1">{t('wp_upload_invalid')}</p>}
              </td>
              <td className={`${cell} text-right text-xs text-fg-muted align-top`}>{effectiveText.maxUploadMb}</td>
              <td className={`${cell} text-right text-xs text-fg-subtle align-top`}>{reason(view.sources.content.maxUploadMb)}</td>
            </tr>
            <tr>
              <th scope="row" className={`${cell} text-left font-normal text-fg`}>{t('wp_images')}</th>
              <td className={cell}>
                <select aria-label={t('wp_images')} value={draft.externalImages}
                  onChange={(e) => setDraft({ ...draft, externalImages: e.target.value as PolicyDraft['externalImages'] })}
                  className="input w-auto py-1">
                  {!global && (
                    <option value="inherit">{`${t('proto_setting_inherit')} (${t(IMAGE_KEYS[view.inherited.content.externalImages])})`}</option>
                  )}
                  {EXTERNAL_IMAGE_MODES.map((m) => <option key={m} value={m}>{t(IMAGE_KEYS[m])}</option>)}
                </select>
              </td>
              <td className={`${cell} text-right text-xs text-fg-muted`}>{effectiveText.externalImages}</td>
              <td className={`${cell} text-right text-xs text-fg-subtle`}>{reason(view.sources.content.externalImages)}</td>
            </tr>
          </tbody>
        </table>
        <div className="flex justify-end mt-3">
          <button
            type="button"
            onClick={() => { if (result.ok) save.mutate(result.patch); }}
            disabled={!dirty || !result.ok || save.isPending}
            className="btn-primary disabled:opacity-50 flex items-center gap-2"
          >
            {save.isPending && <Loader2 size={14} className="animate-spin" />}
            {t('wp_save')}
          </button>
        </div>
      </WriteGuard>
    </section>
  );
}
