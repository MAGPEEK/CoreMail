/**
 * 9.5: profile photo in Settings → E-Mail-Konto — a 96 px avatar with
 * "Foto hochladen…" / "Foto ändern…" and "Foto entfernen". Upload and change
 * need the webmail module `profilePhoto`; removing the own photo is always
 * possible. The picked file opens the crop dialog; its 512×512 rendering goes to
 * PUT /api/v1/user/photo, which re-encodes it on the server.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Camera, Trash2 } from 'lucide-react';
import { api, apiFetch } from '../../api/client.js';
import { Avatar } from '../Avatar.js';
import { PhotoCropDialog } from './PhotoCropDialog.js';
import { OWN_PROFILE_KEY, useOwnPhoto, useOwnProfile } from '../../hooks/useUserPhoto.js';
import { useWebmailFeatures } from '../../hooks/useWebmailFeatures.js';
import { PHOTO_FILE_TYPES, photoFileError } from '../../lib/avatarCrop.js';
import { PHOTO_LOOKUP_KEY } from '../../lib/photoDirectory.js';

async function uploadPhoto(png: Blob): Promise<void> {
  const res = await apiFetch('/user/photo', { method: 'PUT', body: png }, 'image/png');
  if (res.ok) return;
  const body = await res.json().catch(() => null) as { error?: string } | null;
  throw new Error(body?.error ?? `Foto konnte nicht gespeichert werden (HTTP ${res.status})`);
}

export function ProfilePhotoSettings() {
  const qc = useQueryClient();
  const { data: profile } = useOwnProfile();
  const photoUrl = useOwnPhoto();
  const canUpload = useWebmailFeatures().features.profilePhoto;
  const fileRef = useRef<HTMLInputElement>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);

  // the picked file's blob: URL lives as long as the dialog
  useEffect(() => () => { if (cropSrc) URL.revokeObjectURL(cropSrc); }, [cropSrc]);

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: OWN_PROFILE_KEY }),
    qc.invalidateQueries({ queryKey: [PHOTO_LOOKUP_KEY] }),
  ]);

  const upload = useMutation({
    mutationFn: uploadPhoto,
    onSuccess: async () => { setCropSrc(null); toast.success('Profilfoto gespeichert'); await refresh(); },
    onError: (err: Error) => toast.error(err.message),
  });
  const remove = useMutation({
    mutationFn: () => api.delete('/user/photo'),
    onSuccess: async () => { toast.success('Profilfoto entfernt'); await refresh(); },
    onError: (err: Error) => toast.error(err.message),
  });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const error = photoFileError(file);
    if (error) { toast.error(error); return; }
    setCropSrc(URL.createObjectURL(file));
  };

  const hasPhoto = !!profile?.photo;
  const name = profile?.displayName ?? '';
  return (
    <div className="flex items-center gap-4">
      <Avatar seed={profile?.email || name || 'user'} name={name} photoUrl={photoUrl} size="xl" />
      <div className="flex flex-wrap gap-2">
        {canUpload && (
          <>
            <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
              <Camera size={14} aria-hidden="true" /> {hasPhoto ? 'Foto ändern…' : 'Foto hochladen…'}
            </button>
            <input ref={fileRef} type="file" accept={PHOTO_FILE_TYPES.join(',')} className="hidden" onChange={onPick} tabIndex={-1} aria-hidden="true" />
          </>
        )}
        {hasPhoto && (
          <button type="button" className="btn-ghost text-danger-fg" disabled={remove.isPending}
            onClick={() => { if (window.confirm('Profilfoto entfernen?')) remove.mutate(); }}>
            <Trash2 size={14} aria-hidden="true" /> Foto entfernen
          </button>
        )}
      </div>
      {cropSrc && (
        <PhotoCropDialog src={cropSrc} busy={upload.isPending} onCancel={() => setCropSrc(null)} onApply={(png) => upload.mutate(png)} />
      )}
    </div>
  );
}
