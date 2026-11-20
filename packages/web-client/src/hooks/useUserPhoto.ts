/**
 * 9.5: profile photos in the webmail.
 *
 *   usePhotoForAddress(address)  photo of an internal sender / attendee / contact
 *                                (batched lookup, lib/photoDirectory.ts) → blob: URL | null
 *   useOwnPhoto()                the signed-in user's photo (GET /user/profile `photo`)
 *   usePhotoUrl(entry)           blob: URL of a known photo
 *
 * Photos are fetched with the Authorization header (never a token in a URL) and
 * shown as blob: URLs of image/jpeg only. One blob per user and photo version
 * (lib/photoDirectory.ts PhotoUrlRegistry); a URL is revoked only when the
 * query cache drops its image query, so an avatar still showing an older
 * version never points at a revoked URL. External addresses resolve to null
 * and keep their initials.
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, fetchBlob } from '../api/client.js';
import {
  PhotoLookupBatcher, PhotoUrlRegistry, PHOTO_IMAGE_KEY, PHOTO_LOOKUP_KEY, normalizeAddress, photoImageKeyParts, photoPath,
  type PhotoEntry,
} from '../lib/photoDirectory.js';
import { rasterImageType } from '../lib/imageTypes.js';

const LOOKUP_STALE_MS = 5 * 60_000;

const batcher = new PhotoLookupBatcher(async (addresses) =>
  (await api.post<{ photos: Record<string, PhotoEntry> }>('/users/photos/lookup', { addresses })).photos ?? {});

const objectUrls = new PhotoUrlRegistry();
const watchedClients = new WeakSet<QueryClient>();

/** Revokes a photo's blob: URL once its image query leaves the cache (once per QueryClient). */
function releaseUrlsOnRemoval(qc: QueryClient): void {
  if (watchedClients.has(qc)) return;
  watchedClients.add(qc);
  qc.getQueryCache().subscribe((event) => {
    if (event.type !== 'removed') return;
    const parts = photoImageKeyParts(event.query.queryKey);
    if (parts) objectUrls.release(...parts);
  });
}

async function loadPhoto(entry: PhotoEntry): Promise<string | null> {
  const known = objectUrls.get(entry.userId, entry.version);
  if (known) return known;
  const blob = await fetchBlob(photoPath(entry));
  if (rasterImageType(blob.type) !== 'image/jpeg') return null;
  return objectUrls.add(entry.userId, entry.version, blob);
}

export function usePhotoUrl(entry: PhotoEntry | null | undefined): string | null {
  releaseUrlsOnRemoval(useQueryClient());
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
