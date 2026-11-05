import { createStore, useStore } from 'zustand';
import {
  activate,
  closeTab,
  cycle,
  EMPTY_TABS,
  goTo,
  HOME,
  moveTab,
  openTab,
  restore,
  type TabsModel,
} from './model.js';

export const PROJECT_SECTIONS = ['context', 'plan', 'execution', 'questions', 'runs'] as const;
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

export interface TabsStore extends TabsModel {
  /** Vrai une fois l'état restauré : avant, rien n'est enregistré. */
  hydrated: boolean;
  /** Réglages affichés à la place du contenu. */
  settingsOpen: boolean;
  /** Section de la barre latérale choisie, par projet. */
  sections: Record<string, ProjectSection>;
  hydrate: (saved: { tabs: string[]; active: string | null }, known: ReadonlySet<string>) => void;
  open: (id: string) => void;
  close: (id: string) => void;
  closeActive: () => void;
  activate: (id: string) => void;
  next: () => void;
  previous: () => void;
  goTo: (position: number) => void;
  move: (id: string, to: number) => void;
  toggleSettings: (open?: boolean) => void;
  setSection: (id: string, section: ProjectSection) => void;
}

export function createTabsStore() {
  return createStore<TabsStore>()((set, get) => {
    const apply = (change: (model: TabsModel) => TabsModel) => {
      const { tabs, active } = get();
      set({ ...change({ tabs, active }), settingsOpen: false });
    };
    return {
      ...EMPTY_TABS,
      hydrated: false,
      settingsOpen: false,
      sections: {},
      hydrate: (saved, known) => {
        set({ ...restore(saved, known), hydrated: true });
      },
      open: (id) => {
        apply((m) => openTab(m, id));
      },
      close: (id) => {
        apply((m) => closeTab(m, id));
      },
      closeActive: () => {
        const { active } = get();
        if (active !== HOME) apply((m) => closeTab(m, active));
      },
      activate: (id) => {
        apply((m) => activate(m, id));
      },
      next: () => {
        apply((m) => cycle(m, 1));
      },
      previous: () => {
        apply((m) => cycle(m, -1));
      },
      goTo: (position) => {
        apply((m) => goTo(m, position));
      },
      move: (id, to) => {
        set(moveTab(get(), id, to));
      },
      toggleSettings: (open) => {
        set((s) => ({ settingsOpen: open ?? !s.settingsOpen }));
      },
      setSection: (id, section) => {
        set((s) => ({ sections: { ...s.sections, [id]: section } }));
      },
    };
  });
}

export type TabsStoreApi = ReturnType<typeof createTabsStore>;

/** Store de l'application. */
export const tabsStore = createTabsStore();

export function useTabs<T>(selector: (state: TabsStore) => T): T {
  return useStore(tabsStore, selector);
}
