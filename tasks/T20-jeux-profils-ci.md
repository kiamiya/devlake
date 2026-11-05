# T20 — Profils Unity et Unreal, CI de jeu

**Jalon :** J3  
**Dépend de :** T14, T18, T19  
**Branche :** `task/T20-jeux-profils-ci`

## Objectif

Faire aboutir des tâches de jeu de bout en bout : agent cloud, éditeur local via le pont, CI, merge.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `templates/quality/unity/`, `templates/quality/unreal/`, profils

## Spécifications

1. Gabarit Unity : GameCI (tests EditMode et PlayMode, build) sur runners GitHub, licence Unity en secret, cache de la Library.
2. Gabarit Unreal : tests d'automatisation lancés via le pont sur l'éditeur local et publiés comme check GitHub, en attendant la décision sur le runner (point ouvert).
3. Groupe de concurrence `agentlake-editor-<dépôt>` : une seule tâche de jeu à la fois par projet.
4. Tâches de code pur C# ou C++ testables sans éditeur : marquées par le planificateur pour ne pas prendre le verrou d'éditeur.

## Critères d'acceptation

- [ ] Sur un projet Unity minimal, « contrôleur de personnage + tests EditMode + scène de test » aboutit à une PR mergée automatiquement.

## Tests exigés

- actionlint et snapshots des gabarits ; `@live` sur un projet Unity de test.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Runner auto-hébergé Unreal.
