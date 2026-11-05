import { useEffect } from 'react';
import { invoke } from '../../lib/ipc.js';
import { HOME } from './model.js';
import type { TabsStoreApi } from './store.js';

/** Restaure les onglets au démarrage, puis enregistre chaque changement. */
export function useTabsPersistence(store: TabsStoreApi): void {
  useEffect(() => {
    let cancelled = false;
    void Promise.all([invoke('tabs:get'), invoke('projects:list')]).then(([saved, projects]) => {
      if (!cancelled) store.getState().hydrate(saved, new Set(projects.map((p) => p.id)));
    });
    const unsubscribe = store.subscribe((state, previous) => {
      if (!state.hydrated || !previous.hydrated) return;
      if (state.tabs === previous.tabs && state.active === previous.active) return;
      void invoke('tabs:save', {
        tabs: state.tabs,
        active: state.active === HOME ? null : state.active,
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store]);
}
