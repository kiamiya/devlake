# T03 — Socle du cockpit

**Jalon :** J1  
**Dépend de :** T00  
**Branche :** `task/T03-socle-cockpit`

## Objectif

Mettre en place l'application desktop : sécurité Electron, IPC typé, cache SQLite, coffre de secrets, réglages.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/desktop/`

## Spécifications

1. electron-vite avec React, Tailwind, shadcn/ui ; sécurité Electron selon `CLAUDE.md`.
2. IPC typé : contrats zod partagés main/renderer, preload qui n'expose que les canaux déclarés, erreurs structurées `{ code, message }`, hooks TanStack Query côté renderer.
3. Cache SQLite (better-sqlite3 + Drizzle, migrations versionnées, WAL) : projets connus, onglets, réglages, miroir des issues et runs. Fonction `rebuildFromGitHub(projet)`.
4. Coffre : jeton GitHub dans `safeStorage`, jamais en base ni dans les logs.
5. Réglages : compte GitHub (défaut Kiamiya), plafond global d'agents, tentatives max, modèles par profil, dossier des clones d'éditeur, config MCP Aura Unity et Unreal (blocs JSON collés depuis Aura). Bouton « Tester » qui vérifie le jeton GitHub.
6. Statut des intégrations (OK, DÉGRADÉ, ABSENT) dans la barre d'état.
7. Ajout du job Windows + macOS dans la CI pour ce paquet, avec un E2E Playwright de lancement.

## Critères d'acceptation

- [ ] Le cockpit démarre, enregistre le jeton, l'affiche masqué, et le statut GitHub passe à OK.
- [ ] Supprimer la base puis relancer reconstruit le cache depuis GitHub.

## Tests exigés

- Unitaires : IPC (validation, canaux interdits), réglages, masquage du jeton.
- Intégration : repositories Drizzle sur base en mémoire, reconstruction avec `FakeGitHub`.
- E2E : lancement, enregistrement d'un réglage, persistance après redémarrage.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Fonctionnalités projet.
