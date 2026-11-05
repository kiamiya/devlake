import { describe, expect, it } from 'vitest';
import { HOME } from './model.js';
import { shortcutAction, runShortcut } from './shortcuts.js';
import { createTabsStore } from './store.js';

const A = 'kiamiya/jeu';
const B = 'kiamiya/site';
const C = 'kiamiya/outil';

function storeWith(...ids: string[]) {
  const store = createTabsStore();
  for (const id of ids) store.getState().open(id);
  return store;
}

const view = (store: ReturnType<typeof createTabsStore>) => {
  const { tabs, active } = store.getState();
  return { tabs, active };
};

describe('store des onglets', () => {
  it('commence sur l’Accueil, ouvre sans doublon et active l’onglet ouvert', () => {
    const store = createTabsStore();
    expect(view(store)).toEqual({ tabs: [], active: HOME });
    store.getState().open(A);
    store.getState().open(B);
    store.getState().open(A);
    expect(view(store)).toEqual({ tabs: [A, B], active: A });
  });

  it('ferme un onglet : l’actif passe à droite, sinon à gauche, sinon à l’Accueil', () => {
    const store = storeWith(A, B, C);
    store.getState().activate(B);
    store.getState().close(B);
    expect(view(store)).toEqual({ tabs: [A, C], active: C });
    store.getState().close(C);
    expect(view(store)).toEqual({ tabs: [A], active: A });
    store.getState().close(A);
    expect(view(store)).toEqual({ tabs: [], active: HOME });
    store.getState().close('inconnu');
    expect(view(store)).toEqual({ tabs: [], active: HOME });
  });

  it('fermer un onglet inactif garde l’actif ; l’Accueil ne se ferme pas', () => {
    const store = storeWith(A, B);
    store.getState().close(A);
    expect(view(store)).toEqual({ tabs: [B], active: B });
    store.getState().activate(HOME);
    store.getState().closeActive();
    expect(view(store)).toEqual({ tabs: [B], active: HOME });
  });

  it('parcourt les onglets en boucle, Accueil compris', () => {
    const store = storeWith(A, B);
    store.getState().next();
    expect(store.getState().active).toBe(HOME);
    store.getState().next();
    expect(store.getState().active).toBe(A);
    store.getState().previous();
    store.getState().previous();
    expect(store.getState().active).toBe(B);
  });

  it('Ctrl+1…8 va au n-ième onglet, Ctrl+9 au dernier', () => {
    const store = storeWith(A, B, C);
    store.getState().goTo(1);
    expect(store.getState().active).toBe(HOME);
    store.getState().goTo(3);
    expect(store.getState().active).toBe(B);
    store.getState().goTo(9);
    expect(store.getState().active).toBe(C);
    store.getState().goTo(7);
    expect(store.getState().active).toBe(C);
  });

  it('réordonne les onglets', () => {
    const store = storeWith(A, B, C);
    store.getState().move(C, 0);
    expect(store.getState().tabs).toEqual([C, A, B]);
    store.getState().move(C, 99);
    expect(store.getState().tabs).toEqual([A, B, C]);
    store.getState().move('inconnu', 0);
    expect(store.getState().tabs).toEqual([A, B, C]);
  });

  it('restaure l’état enregistré en écartant les projets inconnus', () => {
    const store = createTabsStore();
    store.getState().hydrate({ tabs: [B, 'kiamiya/supprime', A, B], active: A }, new Set([A, B]));
    expect({ ...view(store), hydrated: store.getState().hydrated }).toEqual({
      tabs: [B, A],
      active: A,
      hydrated: true,
    });
    store.getState().hydrate({ tabs: [A], active: 'kiamiya/supprime' }, new Set([A]));
    expect(view(store)).toEqual({ tabs: [A], active: HOME });
  });

  it('les réglages s’ouvrent par-dessus et se ferment en changeant d’onglet', () => {
    const store = storeWith(A);
    store.getState().toggleSettings();
    expect(store.getState().settingsOpen).toBe(true);
    store.getState().activate(HOME);
    expect(store.getState().settingsOpen).toBe(false);
    store.getState().toggleSettings(true);
    store.getState().toggleSettings(false);
    expect(store.getState().settingsOpen).toBe(false);
  });

  it('mémorise la section choisie par projet', () => {
    const store = storeWith(A, B);
    store.getState().setSection(A, 'runs');
    expect(store.getState().sections).toEqual({ [A]: 'runs' });
  });
});

describe('raccourcis clavier', () => {
  const key = (
    k: string,
    mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {},
  ) => ({
    key: k,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  });

  it.each([
    [key('Tab'), { type: 'next' }],
    [key('Tab', { shiftKey: true }), { type: 'previous' }],
    [key('w'), { type: 'close' }],
    [key('W'), { type: 'close' }],
    [key('1'), { type: 'goTo', position: 1 }],
    [key('9'), { type: 'goTo', position: 9 }],
  ])('%o → %o', (event, action) => {
    expect(shortcutAction(event)).toEqual(action);
  });

  it.each([
    key('Tab', { ctrlKey: false }),
    key('0'),
    key('w', { shiftKey: true }),
    key('w', { altKey: true }),
    key('1', { metaKey: true }),
    key('a'),
  ])('ignore %o', (event) => {
    expect(shortcutAction(event)).toBeNull();
  });

  it('applique les actions au store', () => {
    const store = storeWith(A, B);
    runShortcut(store, { type: 'goTo', position: 2 });
    expect(store.getState().active).toBe(A);
    runShortcut(store, { type: 'next' });
    expect(store.getState().active).toBe(B);
    runShortcut(store, { type: 'previous' });
    expect(store.getState().active).toBe(A);
    runShortcut(store, { type: 'close' });
    expect(view(store)).toEqual({ tabs: [B], active: B });
  });
});
