# Ajouter un profil qualité

Un profil qualité impose la CI d'un type de projet : les noms de ses jobs sont les checks obligatoires de `main`. La tâche de bootstrap (architecte) copie le gabarit dans `.github/workflows/ci.yml` du projet et adapte les commandes, sans renommer ni vider aucun job.

## Étapes

1. **Identifiant** : ajouter l'id à `QUALITY_PROFILES` (`packages/shared/src/ids.ts`), et l'associer à un type de projet dans `DEFAULT_QUALITY_PROFILE` (`packages/shared/src/quality.ts`).
2. **Checks** : déclarer les checks propres au profil dans `PROFILE_CHECKS` (`quality.ts`). Les checks communs (`CI_CHECKS` : lint, typecheck, tests unitaires et d'intégration, build, audit des dépendances, gitleaks, CodeQL) et ceux de la porte qualité (`agentlake / tests-guard`, `agentlake / review`) s'ajoutent d'office : `requiredChecksFor(profil)` donne la liste posée sur `main`.
3. **Gabarit** : créer `templates/quality/<id>/ci.yml` et `templates/quality/<id>/README.md` :
   - un job par check, `name` identique à l'identifiant du job ;
   - déclencheurs `push` sur `main` et `pull_request`, permissions `contents: read` (CodeQL : `security-events: write`) ;
   - actions épinglées en `@vN`, aucun `continue-on-error`, jamais `pull_request_target`.
4. **Tests** :
   - `packages/dispatcher/src/quality/templates.test.ts` vérifie ces règles pour chaque profil et prend un instantané du gabarit (`-u` pour l'accepter) ;
   - `tests/workflows.test.ts` vérifie les permissions (ajouter le job CodeQL du profil est automatique) ;
   - actionlint tourne sur tous les gabarits en CI.
5. **Planificateur** : ajouter les consignes du type de projet dans `packages/planner/prompts/types/<type>.md` si le type est nouveau.

Le dispatcher ne lance que la tâche de bootstrap tant que les checks de `ciChecksFor(profil)` ne sont pas verts sur `main`, et bloque tout lancement si la protection de `main` ne contient plus `requiredChecksFor(profil)`.
