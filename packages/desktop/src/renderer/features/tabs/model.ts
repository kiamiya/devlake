/** Logique pure des onglets : l'Accueil est fixe, en première position. */

export const HOME = 'home';

export interface TabsModel {
  /** Identifiants de projets (« owner/repo »), dans l'ordre d'affichage. */
  tabs: string[];
  /** Onglet actif : HOME ou un identifiant de projet. */
  active: string;
}

export const EMPTY_TABS: TabsModel = { tabs: [], active: HOME };

/** Ordre complet, Accueil compris. */
function order(model: TabsModel): string[] {
  return [HOME, ...model.tabs];
}

export function openTab(model: TabsModel, id: string): TabsModel {
  const tabs = model.tabs.includes(id) ? model.tabs : [...model.tabs, id];
  return { tabs, active: id };
}

/** Ferme un onglet de projet ; l'actif passe à droite, sinon à gauche, sinon à l'Accueil. */
export function closeTab(model: TabsModel, id: string): TabsModel {
  const index = model.tabs.indexOf(id);
  if (index === -1) return model;
  const tabs = model.tabs.filter((t) => t !== id);
  if (model.active !== id) return { tabs, active: model.active };
  return { tabs, active: tabs[index] ?? tabs[index - 1] ?? HOME };
}

export function activate(model: TabsModel, id: string): TabsModel {
  return order(model).includes(id) ? { ...model, active: id } : model;
}

/** Onglet suivant (+1) ou précédent (-1), en boucle. */
export function cycle(model: TabsModel, step: 1 | -1): TabsModel {
  const all = order(model);
  const index = all.indexOf(model.active);
  const next = all[(index + step + all.length) % all.length];
  return next === undefined ? model : { ...model, active: next };
}

/** Ctrl+1…8 : n-ième onglet (1 = Accueil) ; Ctrl+9 : dernier onglet. */
export function goTo(model: TabsModel, position: number): TabsModel {
  const all = order(model);
  const target = position === 9 ? all[all.length - 1] : all[position - 1];
  return target === undefined ? model : { ...model, active: target };
}

/** Déplace un onglet de projet à la position `to` (parmi les onglets de projets). */
export function moveTab(model: TabsModel, id: string, to: number): TabsModel {
  const from = model.tabs.indexOf(id);
  if (from === -1) return model;
  const tabs = model.tabs.filter((t) => t !== id);
  const clamped = Math.max(0, Math.min(to, tabs.length));
  tabs.splice(clamped, 0, id);
  return { ...model, tabs };
}

/** Garde seulement les projets connus ; l'actif inconnu retombe sur l'Accueil. */
export function restore(
  saved: { tabs: string[]; active: string | null },
  known: ReadonlySet<string>,
): TabsModel {
  const tabs = [...new Set(saved.tabs)].filter((id) => known.has(id));
  const active = saved.active !== null && tabs.includes(saved.active) ? saved.active : HOME;
  return { tabs, active };
}
