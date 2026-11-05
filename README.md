# AgentLake (dépôt `devlake`)

AgentLake transforme un brief ou un GDD en plan de tâches validé, puis fait réaliser ces tâches par des agents Claude Code qui tournent dans GitHub Actions. Le cadrage complet est dans [`docs/cadrage.md`](docs/cadrage.md), les règles de travail dans [`CLAUDE.md`](CLAUDE.md) et les tâches dans [`tasks/`](tasks/README.md).

## Prérequis

- Node.js 24 (LTS), voir `.nvmrc`
- npm 11

## Installation

```bash
npm install
```

## Commandes

| Commande                   | Rôle                                                    |
| -------------------------- | ------------------------------------------------------- |
| `npm run dev -w desktop`   | Cockpit en développement (arrive avec T03)              |
| `npm test`                 | Tests unitaires, réseau interdit, couverture v8 ≥ 80 %  |
| `npm run test:integration` | Tests d'intégration (`*.integration.test.ts`)           |
| `npm run test:e2e`         | Tests Playwright du cockpit (arrivent avec T03)         |
| `npm run lint`             | ESLint strict et vérification Prettier                  |
| `npm run typecheck`        | Vérification des types de tous les paquets et des tests |
| `npm run depcruise`        | Règles de dépendances entre paquets                     |
| `npm run build`            | Compilation `tsc -b`                                    |

## Paquets

| Paquet        | Rôle                                              | Peut dépendre de            |
| ------------- | ------------------------------------------------- | --------------------------- |
| `shared`      | Schémas zod partagés                              | rien                        |
| `github`      | Port GitHub et adaptateur Octokit                 | shared                      |
| `planner`     | Prompts, validateur de plan, job de planification | shared, github              |
| `dispatcher`  | Tâches prêtes, capacité, lancement des jobs       | shared, github              |
| `aura-bridge` | Pont MCP vers Aura                                | shared                      |
| `desktop`     | Cockpit Electron                                  | shared, github, aura-bridge |
