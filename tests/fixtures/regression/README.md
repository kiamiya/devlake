# Bibliothèque de régression

Données de référence partagées par les tests unitaires, d'intégration, E2E et `@live` (T22).

| Dossier      | Contenu                                                                                                                                       | Utilisé par                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `briefs/`    | Briefs de référence (Markdown), tels que Kia les verse dans le contexte.                                                                      | Scénarios ci-dessous ; planificateur réel du workflow nocturne `@live`.                              |
| `scenarios/` | Un scénario par projet : questions et plan renvoyés par Claude, comportement scripté des agents (question bloquante, échecs de CI), attendus. | Monde simulé (`packages/desktop/src/main/testing/world.ts`) : test sans interface et E2E Playwright. |
| `events/`    | Séquences d'événements GitHub et décision attendue du dispatcher (passe ou non).                                                              | Tests du filtre d'événements du dispatcher.                                                          |

## Règles

- Le planificateur est un LLM : en CI, les plans attendus sont **validés** (schéma, graphe) puis **rejoués** jusqu'au bout par le vrai dispatcher. La comparaison avec le planificateur réel n'a lieu qu'en `@live`, par des contrôles structurels (nombre de tâches, profils, tests exigés), jamais à l'identique.
- Un scénario se valide contre `RegressionScenarioSchema` ; un fichier invalide fait échouer les tests.
- Ajouter un cas : un brief, un scénario qui y renvoie, et ses attendus (`expected.launches` : lancements d'agent par tâche, 1 sans incident, +1 par question bloquante et par échec de CI).
