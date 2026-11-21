/**
 * 9.4: Settings → Sicherheit, additional panels:
 *  - active sessions (web/BCP/CLI logins) with device, IP, last use; end one or all others
 *  - ActiveSync devices (GET/DELETE /smime/devices)
 *  - S/MIME processing options (GET/PUT /smime/settings)
 *  - 10.6: remembered MFA devices (GET/DELETE /user/trusted-devices)
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, LogOut, Smartphone } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../api/client.js';
import { useRegional } from '../../store/preferences.js';
import { formatDateTime } from '../../lib/regionalFormat.js';
import { describeUserAgent } from '../../lib/sessionDevice.js';
import { CheckField, Group } from './controls.js';
import { fmt, useT } from '../../i18n/useT.js';

interface SessionRow {
  id: string;
  ipAddress: string;
  userAgent: string;
  mfaVerified: boolean;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

interface DeviceRow {
  id: string;
  deviceId: string;
  deviceType: string | null;
  deviceFriendlyName: string | null;
  status: string;
  lastSyncAt: string | null;
}

interface SmimeSettings { autoSign: boolean; autoEncrypt: boolean; verifyIncoming: boolean; decryptIncoming: boolean }

function useWhen(): (iso: string | null) => string {
  const regional = useRegional();
  return (iso) => (iso ? formatDateTime(new Date(iso), regional) : '–');
}

interface TrustedDeviceRow {
  id: string;
  surface: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  userAgent: string;
  ipPrefix: string;
}

/** 10.6: browsers that skip the MFA step ("Auf diesem Gerät nicht mehr fragen"); revoke one or all. */
export function TrustedDevicesPanel() {
  const t = useT();
  const qc = useQueryClient();
  const when = useWhen();
  const { data, isLoading } = useQuery({
    queryKey: ['user-trusted-devices'],
    queryFn: () => api.get<{ devices: TrustedDeviceRow[] }>('/user/trusted-devices'),
  });
  const done = (msg: string) => { toast.success(msg); void qc.invalidateQueries({ queryKey: ['user-trusted-devices'] }); };
  const revoke = useMutation({ mutationFn: (id: string) => api.delete(`/user/trusted-devices/${encodeURIComponent(id)}`), onSuccess: () => done(t('mfa_devices_revoked')) });
  const revokeAll = useMutation({ mutationFn: () => api.delete('/user/trusted-devices'), onSuccess: () => done(t('mfa_devices_revoked_all')) });
  const devices = data?.devices ?? [];

  return (
    <Group title={t('mfa_devices_title')}>
      <p className="text-xs text-fg-subtle">{t('mfa_devices_hint')}</p>
      {isLoading ? <Loader2 size={16} className="animate-spin text-fg-subtle" /> : devices.length === 0 ? (
        <p className="text-sm text-fg-subtle">{t('mfa_devices_none')}</p>
      ) : (
        <ul className="divide-y divide-line border border-line rounded-md">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <div className="flex-1 min-w-0">
                <p className="text-fg">{d.userAgent || '–'} · {t(d.surface === 'bcp' ? 'mfa_devices_bcp' : 'mfa_devices_webmail')}</p>
                <p className="text-xs text-fg-subtle">
                  {fmt(t('mfa_devices_meta'), { net: d.ipPrefix || '–', last: when(d.lastUsedAt ?? d.createdAt), until: when(d.expiresAt) })}
                </p>
              </div>
              <button type="button" className="btn-ghost text-xs" disabled={revoke.isPending} onClick={() => revoke.mutate(d.id)}>
                <LogOut size={13} /> {t('mfa_devices_revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {devices.length > 1 && (
        <button type="button" className="btn-secondary text-xs" disabled={revokeAll.isPending} onClick={() => revokeAll.mutate()}>
          {t('mfa_devices_revoke_all')}
        </button>
      )}
    </Group>
  );
}

export function SessionsPanel() {
  const qc = useQueryClient();
  const when = useWhen();
  const { data, isLoading } = useQuery({ queryKey: ['user-sessions'], queryFn: () => api.get<SessionRow[]>('/auth/sessions') });
  const done = (msg: string) => { toast.success(msg); void qc.invalidateQueries({ queryKey: ['user-sessions'] }); };
  const revoke = useMutation({ mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`), onSuccess: () => done('Sitzung beendet') });
  const revokeOthers = useMutation({ mutationFn: () => api.post('/auth/sessions/revoke-others', {}), onSuccess: () => done('Alle anderen Sitzungen beendet') });
  const others = (data ?? []).filter((s) => !s.current).length;

  return (
    <Group title="Angemeldete Sitzungen">
      {isLoading ? <Loader2 size={16} className="animate-spin text-fg-subtle" /> : (
        <ul className="divide-y divide-line border border-line rounded-md">
          {(data ?? []).map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <div className="flex-1 min-w-0">
                <p className="text-fg">{describeUserAgent(s.userAgent)}{s.current && <span className="ml-2 text-xs text-accent-fg">Diese Sitzung</span>}</p>
                <p className="text-xs text-fg-subtle">IP {s.ipAddress || '–'} · zuletzt aktiv {when(s.lastUsedAt)} · angemeldet {when(s.createdAt)}</p>
              </div>
              {!s.current && (
                <button type="button" className="btn-ghost text-xs" disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)}>
                  <LogOut size={13} /> Beenden
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {others > 0 && (
        <button type="button" className="btn-secondary text-xs" disabled={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
          Alle anderen Sitzungen beenden
        </button>
      )}
    </Group>
  );
}

const DEVICE_STATUS: Record<string, string> = { OK: 'Aktiv', BLOCKED: 'Gesperrt', PENDING: 'Wartet auf Freigabe', WIPED: 'Wird gelöscht' };

export function DevicesPanel() {
  const qc = useQueryClient();
  const when = useWhen();
  const { data, isLoading } = useQuery({ queryKey: ['user-devices'], queryFn: () => api.get<DeviceRow[]>('/smime/devices') });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/smime/devices/${id}`),
    onSuccess: () => { toast.success('Gerät entfernt'); void qc.invalidateQueries({ queryKey: ['user-devices'] }); },
  });

  return (
    <Group title="Mobile Geräte (ActiveSync)">
      {isLoading ? <Loader2 size={16} className="animate-spin text-fg-subtle" /> : (data ?? []).length === 0 ? (
        <p className="text-sm text-fg-subtle">Keine Geräte verbunden.</p>
      ) : (
        <ul className="divide-y divide-line border border-line rounded-md">
          {(data ?? []).map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Smartphone size={16} className="text-fg-subtle shrink-0" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="text-fg truncate">{d.deviceFriendlyName || d.deviceType || d.deviceId}</p>
                <p className="text-xs text-fg-subtle">{DEVICE_STATUS[d.status] ?? d.status} · zuletzt synchronisiert {when(d.lastSyncAt)}</p>
              </div>
              {d.status === 'OK' && (
                <button type="button" className="btn-ghost text-xs" disabled={remove.isPending}
                  onClick={() => { if (window.confirm('Gerät entfernen? Es muss sich danach neu anmelden.')) remove.mutate(d.id); }}>
                  Entfernen
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Group>
  );
}

export function SmimeSettingsPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['smime-settings'], queryFn: () => api.get<SmimeSettings>('/smime/settings') });
  const save = useMutation({
    mutationFn: (patch: Partial<SmimeSettings>) => api.put<SmimeSettings>('/smime/settings', patch),
    onSuccess: (s) => { qc.setQueryData(['smime-settings'], s); toast.success('S/MIME-Einstellungen gespeichert'); },
  });
  if (!data) return null;
  const field = (key: keyof SmimeSettings, label: string, hint?: string) => (
    <CheckField label={label} checked={data[key]} onChange={(v) => save.mutate({ [key]: v })} {...(hint ? { hint } : {})} />
  );

  return (
    <Group title="S/MIME">
      {field('autoSign', 'Ausgehende Nachrichten signieren', 'Erfordert ein Zertifikat, das als Standard für das Signieren festgelegt ist.')}
      {field('autoEncrypt', 'Ausgehende Nachrichten verschlüsseln, wenn Zertifikate aller Empfänger vorliegen')}
      {field('verifyIncoming', 'Signaturen eingehender Nachrichten prüfen')}
      {field('decryptIncoming', 'Eingehende verschlüsselte Nachrichten entschlüsseln')}
    </Group>
  );
}
