# Index des tâches AgentLake

Une PR par tâche. Une tâche démarre dès que toutes ses dépendances sont mergées ; les tâches sans dépendance commune peuvent avancer en parallèle.

| ID | Tâche | Jalon | Dépend de | Fichier |
| --- | --- | --- | --- | --- |
| T00 | Socle du monorepo | J1 | — | [T00-socle-monorepo.md](T00-socle-monorepo.md) |
| T01 | Schémas partagés | J1 | T00 | [T01-schemas-partages.md](T01-schemas-partages.md) |
| T02 | Port et adaptateur GitHub | J1 | T01 | [T02-port-github.md](T02-port-github.md) |
| T03 | Socle du cockpit | J1 | T00 | [T03-socle-cockpit.md](T03-socle-cockpit.md) |
| T04 | Coque du cockpit et onglets | J1 | T03 | [T04-onglets.md](T04-onglets.md) |
| T05 | Création de projet et bootstrap du dépôt | J1 | T02, T04 | [T05-bootstrap-projet.md](T05-bootstrap-projet.md) |
| T06 | Ingestion des documents | J1 | T02, T03 | [T06-ingestion.md](T06-ingestion.md) |
| T07 | Bibliothèque de contexte | J1 | T05, T06 | [T07-bibliotheque-contexte.md](T07-bibliotheque-contexte.md) |
| T08 | Workflows réutilisables et workflow d'agent | J1 | T01 | [T08-workflows-agent.md](T08-workflows-agent.md) |
| T09 | Planificateur | J1 | T06, T08 | [T09-planificateur.md](T09-planificateur.md) |
| T10 | Revue et validation du plan | J1 | T04, T09 | [T10-revue-plan.md](T10-revue-plan.md) |
| T11 | Profils d'agents | J2 | T08 | [T11-profils-agents.md](T11-profils-agents.md) |
| T12 | Dispatcher | J2 | T10, T11 | [T12-dispatcher.md](T12-dispatcher.md) |
| T13 | Protocole de questions et décisions | J2 | T12 | [T13-questions.md](T13-questions.md) |
| T14 | Porte qualité et merge automatique | J2 | T12 | [T14-porte-qualite.md](T14-porte-qualite.md) |
| T15 | Boîte de questions du cockpit | J2 | T13 | [T15-boite-questions.md](T15-boite-questions.md) |
| T16 | Tableau de bord et journaux des runs | J2 | T12 | [T16-tableau-de-bord.md](T16-tableau-de-bord.md) |
| T17 | Pont Aura | J3 | T03 | [T17-pont-aura.md](T17-pont-aura.md) |
| T18 | Tunnel, santé du pont et interrupteur | J3 | T17 | [T18-tunnel-sante.md](T18-tunnel-sante.md) |
| T19 | Synchronisation de l'éditeur | J3 | T17 | [T19-synchro-editeur.md](T19-synchro-editeur.md) |
| T20 | Profils Unity et Unreal, CI de jeu | J3 | T14, T18, T19 | [T20-jeux-profils-ci.md](T20-jeux-profils-ci.md) |
| T21 | Robustesse et garde-fous | J4 | T14 | [T21-robustesse.md](T21-robustesse.md) |
| T22 | Suite E2E et bibliothèque de régression | J4 | T15, T16, T21 | [T22-e2e-regression.md](T22-e2e-regression.md) |
| T23 | Packaging et documentation | J4 | T22 | [T23-packaging.md](T23-packaging.md) |

## Jalons

- **J1 — Du brief au plan validé** : T00 à T10
- **J2 — Exécution cloud** : T11 à T16 (ensuite, AgentLake peut réaliser ses propres tâches J3 et J4)
- **J3 — Jeux vidéo via le pont Aura** : T17 à T20
- **J4 — Robustesse et livraison** : T21 à T23

## Prompt type à donner à Claude Code

```
Réalise la tâche tasks/T00-socle-monorepo.md.
Respecte CLAUDE.md et docs/cadrage.md.
Si un point n'est pas couvert par la documentation, pose-moi la question avant de coder.
Termine par une PR sur la branche indiquée dans la tâche, avec tous les tests verts.
```
