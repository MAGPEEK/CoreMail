import { create } from 'zustand';
import type { AdminAreas } from '../lib/adminAreas.js';

interface AccessState {
  /** null = not (yet) known / backend without adminAreas → previous behaviour (everything visible) */
  areas: AdminAreas | null;
  setAreas: (areas: AdminAreas | null) => void;
}

/** Admin areas of the signed-in admin (from GET /api/v1/user/me). */
export const useAccessStore = create<AccessState>()((set) => ({
  areas: null,
  setAreas: (areas) => set({ areas }),
}));
