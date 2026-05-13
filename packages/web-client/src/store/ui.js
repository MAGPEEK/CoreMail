import { create } from 'zustand';
export const useUiStore = create((set) => ({
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
