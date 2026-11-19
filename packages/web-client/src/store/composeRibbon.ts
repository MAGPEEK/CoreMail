/**
 * 10.1: bridge between the draft shown in the reading pane and the ribbon's
 * contextual tabs (Nachricht | Einfügen | Text formatieren | Optionen).
 *
 * The inline compose (components/compose/ComposePane.tsx) publishes its editor,
 * state and actions after every render; the ribbon builds its commands from
 * them with the same command definitions as the compose card's own bars
 * (components/compose/composeRibbon.tsx), so both run the same actions. The
 * ribbon reports back whether it currently shows these commands — the card
 * then keeps only Senden, the draft status and close (no clutter twice).
 */
import { create } from 'zustand';
import type { Editor } from '@tiptap/react';
import type { ComposeCommandActions, ComposeCommandState } from '../components/compose/ComposeCommandRow.js';

export interface ComposeRibbonApi {
  tabKey: string;
  editor: Editor | null;
  /** Size new text starts with (base of Schrift größer / kleiner). */
  defaultSize: string;
  state: ComposeCommandState;
  actions: ComposeCommandActions & {
    openLink: () => void;
    /** "Lesebestätigung anfordern" on / off (only while the option is offered). */
    toggleRequestReceipt: () => void;
  };
  requestReceipt: boolean;
  receiptVisible: boolean;
}

interface ComposeRibbonState {
  api: ComposeRibbonApi | null;
  /** Tab key of the draft whose commands the ribbon shows right now (null = none). */
  shownFor: string | null;
  publish: (api: ComposeRibbonApi) => void;
  /** The draft went away: forget it (only if it is still the published one). */
  withdraw: (tabKey: string) => void;
  setShownFor: (tabKey: string | null) => void;
}

export const useComposeRibbon = create<ComposeRibbonState>((set, get) => ({
  api: null,
  shownFor: null,
  publish: (api) => set({ api }),
  withdraw: (tabKey) => { if (get().api?.tabKey === tabKey) set({ api: null }); },
  setShownFor: (shownFor) => { if (get().shownFor !== shownFor) set({ shownFor }); },
}));
