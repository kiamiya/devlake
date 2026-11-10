# État des lieux d'un projet repris

Projet : {{PROJECT}}

{{TYPE_GUIDANCE}}

Le dépôt existait avant AgentLake : du code, des assets et peut-être une CI sont déjà là. Avant de planifier la suite, dresse l'état des lieux du dépôt, dans le dossier de travail (lecture seule : Read, Glob, Grep).

## Issues ouvertes (hors AgentLake)

{{ISSUES}}

## Pull requests ouvertes

{{PULLS}}

## Consigne de Kia

{{INSTRUCTION}}

## Ce que l'état des lieux doit contenir

Un document Markdown en français, factuel, qui cite les chemins réels du dépôt. Sections, dans cet ordre :

1. **Résumé** : ce que fait le projet, en quelques lignes.
2. **Stack** : langages, frameworks, moteur et version (Unity : `ProjectSettings/ProjectVersion.txt` ; Unreal : `.uproject`), dépendances principales, outils de build.
3. **Structure** : dossiers principaux et leur rôle ; conventions de nommage et d'organisation constatées.
4. **Tests et CI** : tests existants (où, quel framework, quelle couverture apparente), workflows `.github/workflows/`, ce qu'ils vérifient.
5. **Assets** (projets de jeu) : scènes, prefabs ou niveaux, fichiers `.blend` et leurs exports, binaires hors Git LFS.
6. **Ce qui marche, ce qui est inachevé** : fonctionnalités en place, TODO/FIXME notables, code mort, dette technique.
7. **Issues et PR ouvertes** : regroupées par thème, avec leurs numéros, et ce qu'elles disent du travail restant.
8. **Risques et points d'attention** pour des agents qui vont travailler dessus (fichiers sensibles, conventions à ne pas casser, secrets attendus).

N'invente rien : ce que tu n'as pas pu vérifier est signalé comme tel. Ne propose pas encore de plan.
