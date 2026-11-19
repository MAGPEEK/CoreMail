import { create } from 'zustand';
import type { AdminAreas } from '../lib/adminAreas.js';
import { ORGANISATION_SCOPE, type AdminActions, type AdminScope, type Permissions } from '../lib/permissions.js';

interface AccessState {
  /** 9.5: management scope (organisation-wide until known — the server enforces it). */
  scope: AdminScope;
  /** null = not (yet) known / backend without permissions → previous behaviour (everything visible) */
  areas: AdminAreas | null;
  /** Narrow actions (null = not sent by the server → derived from write access). */
  actions: AdminActions | null;
  role: string | null;
  mfaVerified: boolean;
  /** 'loading' until GET /admin/me/permissions answered (or failed). */
  status: 'loading' | 'ready';
  setPermissions: (p: Permissions) => void;
  /** Lookup failed — keep the previous behaviour (server still enforces). */
  setUnknown: () => void;
  /** Back to the initial state (logout). */
  reset: () => void;
}

/**
 * Permissions of the signed-in admin (GET /api/v1/admin/me/permissions).
 * Components read them through usePermissions() / <Can>, never directly.
 */
export const useAccessStore = create<AccessState>()((set) => ({
  areas: null,
  actions: null,
  scope: ORGANISATION_SCOPE,
  role: null,
  mfaVerified: false,
  status: 'loading',
  setPermissions: (p) => set({ areas: p.areas, actions: p.actions, scope: p.scope, role: p.role, mfaVerified: p.mfaVerified, status: 'ready' }),
  setUnknown: () => set({ areas: null, actions: null, scope: ORGANISATION_SCOPE, role: null, mfaVerified: false, status: 'ready' }),
  reset: () => set({ areas: null, actions: null, scope: ORGANISATION_SCOPE, role: null, mfaVerified: false, status: 'loading' }),
}));
