# T19 — Synchronisation de l'éditeur

**Jalon :** J3  
**Dépend de :** T17  
**Branche :** `task/T19-synchro-editeur`

## Objectif

Garder cohérents le code poussé par l'agent dans le runner et les modifications faites dans l'éditeur via Aura.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/aura-bridge/src/editor-sync/`

## Spécifications

1. Clone dédié du dépôt par projet de jeu (dossier des réglages), distinct de la copie de travail de Kia, ouvert dans l'éditeur.
2. Outils MCP ajoutés par le pont : `editor_checkout(branch)` (fetch, checkout, attente de la fin de l'import ou de la compilation), `editor_commit_push(message)` (commit des scènes, prefabs, `.meta`, assets ; push sur la branche de la tâche), `editor_status` (branche, fichiers modifiés, erreurs de compilation).
3. Refus de checkout si des modifications non poussées existent ; refus de push sur `main`.
4. Unity : sérialisation des assets en texte forcée, Git LFS pour les binaires ; Unreal : équivalent pour les `.uasset` via LFS.
5. Ordre imposé dans le prompt des profils de jeu : push du code → `editor_checkout` → outils Aura → `editor_commit_push` → pull dans le runner → tests.

## Critères d'acceptation

- [ ] Une tâche Unity de test modifie un script et une scène ; les deux arrivent sur la même branche et la PR passe la CI.

## Tests exigés

- Unitaires : refus (modifications en attente, push sur main) ; intégration : dépôt git réel temporaire.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Génération d'assets 3D ou audio.
