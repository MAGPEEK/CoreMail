import { create } from 'zustand';

interface UiState {
  selectedFolderId: string | null;
  selectedMessageId: string | null;
  composeOpen: boolean;
  composeReplyTo: { id: string; subject: string; fromAddr: string } | null;
  sidebarCollapsed: boolean;
  setSelectedFolder: (id: string | null) => void;
  setSelectedMessage: (id: string | null) => void;
  openCompose: (replyTo?: { id: string; subject: string; fromAddr: string }) => void;
  closeCompose: () => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedFolderId: null,
  selectedMessageId: null,
  composeOpen: false,
  composeReplyTo: null,
  sidebarCollapsed: false,
  setSelectedFolder: (id) => set({ selectedFolderId: id, selectedMessageId: null }),
  setSelectedMessage: (id) => set({ selectedMessageId: id }),
  openCompose: (replyTo) => set({ composeOpen: true, composeReplyTo: replyTo ?? null }),
  closeCompose: () => set({ composeOpen: false, composeReplyTo: null }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));
