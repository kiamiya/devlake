# T04 — Coque du cockpit et onglets

**Jalon :** J1  
**Dépend de :** T03  
**Branche :** `task/T04-onglets`

## Objectif

Travailler sur plusieurs projets en parallèle, un onglet par projet.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/desktop/src/renderer/app/`, `features/tabs/`

## Spécifications

1. Barre d'onglets, barre latérale du projet (Contexte, Plan, Exécution, Questions, Runs), barre d'état globale (agents actifs / plafond, questions en attente, statut des intégrations).
2. Onglet Accueil fixe : liste des projets, création, ouverture d'un dépôt existant déjà bootstrappé.
3. Ouvrir, fermer, réordonner les onglets ; badge de questions ; indicateur d'activité ; état restauré au démarrage.
4. Raccourcis Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+W, Ctrl+1…9.
5. Fermer un onglet ou le cockpit n'arrête rien côté GitHub.

## Critères d'acceptation

- [ ] Trois projets ouverts, navigation au clavier, redémarrage : mêmes onglets dans le même ordre.

## Tests exigés

- Store Zustand des onglets ; composants (badges, raccourcis) ; E2E de persistance.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Contenu des vues.
