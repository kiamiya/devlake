import { useEffect } from 'react';
import type { TabsStoreApi } from './store.js';

export type ShortcutAction =
  { type: 'next' } | { type: 'previous' } | { type: 'close' } | { type: 'goTo'; position: number };

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+W, Ctrl+1…9. */
export function shortcutAction(event: KeyLike): ShortcutAction | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.key === 'Tab') return event.shiftKey ? { type: 'previous' } : { type: 'next' };
  if (event.shiftKey) return null;
  if (event.key === 'w' || event.key === 'W') return { type: 'close' };
  if (/^[1-9]$/.test(event.key)) return { type: 'goTo', position: Number(event.key) };
  return null;
}

export function runShortcut(store: TabsStoreApi, action: ShortcutAction): void {
  const state = store.getState();
  switch (action.type) {
    case 'next':
      state.next();
      return;
    case 'previous':
      state.previous();
      return;
    case 'close':
      state.closeActive();
      return;
    case 'goTo':
      state.goTo(action.position);
      return;
  }
}

/** Branche les raccourcis clavier des onglets sur la fenêtre. */
export function useTabShortcuts(store: TabsStoreApi): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = shortcutAction(event);
      if (!action) return;
      event.preventDefault();
      runShortcut(store, action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [store]);
}
