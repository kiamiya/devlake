# T16 — Tableau de bord et journaux des runs

**Jalon :** J2  
**Dépend de :** T12  
**Branche :** `task/T16-tableau-de-bord`

## Objectif

Voir d'un coup d'œil où en est chaque projet et ce que fait chaque agent.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/desktop/src/renderer/features/dashboard/`, `features/runs/`

## Spécifications

1. Kanban par état, avancement pondéré par complexité, jalons, graphe des dépendances coloré par état.
2. Runs en cours et passés : profil, tâche, durée, tentative, conclusion ; journal et transcription téléchargés depuis les artefacts, affichage virtualisé.
3. Liens vers issue, PR, checks.
4. Consommation : minutes Actions par projet et sur le mois, nombre de runs par tâche.
5. Actions : mettre un projet en pause (label sur le dépôt lu par le dispatcher), relancer une tâche escaladée.

## Critères d'acceptation

- [ ] Avancement exact sur un projet simulé de 10 tâches ; journal de 10 000 lignes fluide.

## Tests exigés

- Unitaires : avancement, agrégation des minutes ; composants ; E2E.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Statistiques historiques multi-projets.
