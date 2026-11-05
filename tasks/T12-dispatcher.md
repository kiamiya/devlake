# T12 — Dispatcher

**Jalon :** J2  
**Dépend de :** T10, T11  
**Branche :** `task/T12-dispatcher`

## Objectif

Lancer les bonnes tâches au bon moment, avec le bon parallélisme, sans conflit, et rattraper tout événement manqué.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/dispatcher/`, `.github/workflows/dispatcher.yml`

## Spécifications

1. Déclencheurs : `issues` (labeled, closed), `issue_comment`, `pull_request` (closed), `check_suite`, `workflow_run` (completed), `workflow_dispatch`, et `schedule` toutes les 10 minutes pour le rattrapage. Groupe de concurrence unique par dépôt pour sérialiser les passes.
2. Filtre d'auteur : tout événement dont l'auteur n'est pas le propriétaire du dépôt (ou le bot du dispatcher lui-même) est ignoré, avec une trace dans le journal du run.
3. Passe : lit l'état de toutes les issues de tâches, calcule les tâches prêtes (dépendances fermées par PR mergée, aucune ressource exclusive occupée, pas d'attente), puis la capacité restante (plafond projet, plafond global lu dans un dépôt de config, jobs en cours, minutes restantes).
4. Priorité au chemin critique du graphe.
5. Lance `agent-task.yml` par `workflow_dispatch` et pose `state/running` avant le lancement (idempotence : pas de double lancement si deux passes se chevauchent).
6. Détecte les jobs morts (run terminé sans mise à jour de l'issue) et les remet en file.
7. Gère les tentatives : compteur dans les métadonnées de l'issue, escalade au-delà du maximum.
8. Ne lance une tâche de jeu que si le pont répond en santé ; sinon `state/waiting-editor`.

## Critères d'acceptation

- [ ] Sur un graphe de 10 tâches avec plafond 3, jamais plus de 3 agents simultanés et l'ordre respecte les dépendances.
- [ ] Rejouer la même passe deux fois ne lance rien de plus.
- [ ] Une issue ou un commentaire créé par un autre compte ne déclenche aucun agent.

## Tests exigés

- Unitaires : tâches prêtes, capacité, priorité, idempotence, jobs morts.
- Tests de propriétés (fast-check) : sur graphes aléatoires, aucune violation de dépendance ni de ressource exclusive.
- Intégration : simulation de bout en bout avec `FakeGitHub` et horloge simulée.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Contenu des jobs d'agent.
