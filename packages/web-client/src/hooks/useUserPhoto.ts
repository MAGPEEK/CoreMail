/**
 * 9.5: profile photos in the webmail.
 *
 *   usePhotoForAddress(address)  photo of an internal sender / attendee / contact
 *                                (batched lookup, lib/photoDirectory.ts) → blob: URL | null
 *   useOwnPhoto()                the signed-in user's photo (GET /user/profile `photo`)
 *   usePhotoUrl(entry)           blob: URL of a known photo
 *
 * Photos are fetched with the Authorization header (never a token in a URL) and
 * shown as blob: URLs of image/jpeg only. One blob per user and photo version;
 * the URL of an older version of the same user is revoked when a newer one
 * loads. External addresses resolve to null and keep their initials.
 */
import { useQuery } from '@tanstack/react-query';
import { api, fetchBlob } from '../api/client.js';
import {
  PhotoLookupBatcher, PHOTO_IMAGE_KEY, PHOTO_LOOKUP_KEY, normalizeAddress, photoPath, type PhotoEntry,
} from '../lib/photoDirectory.js';
import { rasterImageType } from '../lib/imageTypes.js';

const LOOKUP_STALE_MS = 5 * 60_000;

const batcher = new PhotoLookupBatcher(async (addresses) =>
  (await api.post<{ photos: Record<string, PhotoEntry> }>('/users/photos/lookup', { addresses })).photos);

/** userId → [version, blob URL] of the newest photo loaded in this tab. */
const objectUrls = new Map<string, [string, string]>();

async function loadPhoto(entry: PhotoEntry): Promise<string | null> {
  const previous = objectUrls.get(entry.userId);
  if (previous?.[0] === entry.version) return previous[1];
  const blob = await fetchBlob(photoPath(entry));
  if (rasterImageType(blob.type) !== 'image/jpeg') return null;
  const url = URL.createObjectURL(blob);
  if (previous) URL.revokeObjectURL(previous[1]);
  objectUrls.set(entry.userId, [entry.version, url]);
  return url;
}

export function usePhotoUrl(entry: PhotoEntry | null | undefined): string | null {
  const { data } = useQuery({
    queryKey: [PHOTO_IMAGE_KEY, entry?.userId ?? '', entry?.version ?? ''],
    queryFn: () => loadPhoto(entry!),
    enabled: !!entry,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
  return entry ? data ?? null : null;
}

export function usePhotoForAddress(address: string | null | undefined): string | null {
  const key = normalizeAddress(address);
  const { data } = useQuery({
    queryKey: [PHOTO_LOOKUP_KEY, key ?? ''],
    queryFn: () => batcher.get(key!),
    enabled: key !== null,
    staleTime: LOOKUP_STALE_MS,
  });
  return usePhotoUrl(key ? data : null);
}

/** GET /user/profile (shared with Settings → E-Mail-Konto). */
export interface OwnProfile {
  id: string;
  email: string;
  displayName: string;
  photo: { userId: string; version: string; updatedAt: string | null } | null;
}

export const OWN_PROFILE_KEY = ['user-profile'] as const;

export function useOwnProfile() {
  return useQuery({ queryKey: OWN_PROFILE_KEY, queryFn: () => api.get<OwnProfile>('/user/profile') });
}

export function useOwnPhoto(): string | null {
  return usePhotoUrl(useOwnProfile().data?.photo ?? null);
}
