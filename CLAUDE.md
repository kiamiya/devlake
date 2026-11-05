# AgentLake — instructions pour Claude Code

AgentLake transforme un brief ou un GDD en plan de tâches validé par Kia, puis fait réaliser ces tâches par des agents Claude Code **qui tournent dans GitHub Actions** (`anthropics/claude-code-action`). Le merge sur `main` est automatique quand toute la CI est verte. Un cockpit desktop (Electron) sert à piloter et à suivre ; il n'exécute aucun agent. Seul le **pont Aura** tourne sur le poste, pour que les agents cloud pilotent l'éditeur Unity/Unreal via le MCP d'Aura.

Le cadrage complet est dans `docs/cadrage.md`. Les tâches sont dans `tasks/`, dans l'ordre de `tasks/README.md`.

## Principes d'architecture (hérités de l'agent lake PRIF)

- **GitHub est le bus d'événements et la source de vérité** : issues = tâches, labels `agentlake:state/*` = états, commentaires structurés = questions et réponses, PR + checks = livraison. Aucun état critique en mémoire.
- **Suspendre / reprendre** : une question bloquante pose un label d'attente et termine le job ; la réponse relance un job. Une reprise n'a lieu que si l'issue attend exactement cet événement (même identifiant de question) ; tout autre événement est ignoré et tracé.
- **Ports et adaptateurs** : GitHub, Claude, Aura, système de fichiers derrière des interfaces injectées via un objet `runtime` ; chaque paquet fournit `test-utils.ts` avec ses doublures.
- **Garde-fous dans le code, jamais seulement dans le prompt** : tentatives, quotas, permissions, outils autorisés.
- **Idempotence** : tout traitement d'événement peut être rejoué sans effet double ; le dispatcher a une passe planifiée de rattrapage.
- **Relances et délais** : chaque appel sortant a un timeout et des relances avec backoff.
- **Dégradation explicite** : chaque intégration a un statut (OK, DÉGRADÉ, ABSENT) visible dans le cockpit.
- **Aucun modèle Claude codé en dur** : il vient du profil d'agent ou des réglages.
- **Aucune table hors migrations** (cache SQLite du cockpit via Drizzle).

## Stack imposée

- Monorepo npm workspaces, TypeScript strict, ESM, Node LTS ; build `tsc -b`
- zod pour TOUTE donnée qui traverse une frontière (API GitHub, fichiers `.agentlake/`, sorties de Claude, MCP, IPC)
- GitHub : Octokit ; workflows GitHub Actions ; `anthropics/claude-code-action@v1`
- Cockpit : Electron + electron-vite, React 18, Tailwind, shadcn/ui, Zustand, TanStack Query, React Flow, better-sqlite3 + Drizzle
- Pont : SDK MCP TypeScript officiel
- Tests : Vitest (`vitest.config.ts` unitaires sans réseau, `vitest.integration.config.ts` à part), Playwright pour Electron, msw pour simuler GitHub, actionlint pour les workflows
- Qualité : ESLint strict, Prettier, dependency-cruiser, gitleaks

## Organisation

```
packages/
  shared/        # schémas zod : plan, issue de tâche, labels, protocole de questions, config projet
  github/        # port GitHub + adaptateur Octokit (relances, backoff) + doublure
  planner/       # prompts versionnés, validateur de plan, script du job de planification
  dispatcher/    # sélection des tâches prêtes, capacité, lancement des jobs, tentatives
  aura-bridge/   # pont MCP HTTP → serveur MCP Aura local, signature, liste blanche, synchro éditeur
  desktop/       # cockpit Electron (main, preload, renderer)
.github/workflows/  # workflows réutilisables : planner.yml, agent-task.yml, review.yml, dispatcher.yml + CI
templates/       # gabarits posés dans les dépôts de projets (workflows d'appel, CLAUDE.md projet, CI par type)
docs/
tests/e2e, tests/fixtures
```

Règles de dépendances (vérifiées par dependency-cruiser) : `shared` ne dépend de rien ; `github` → shared ; `planner`, `dispatcher` → shared, github ; `aura-bridge` → shared ; `desktop` → shared, github, aura-bridge ; seul `desktop` importe Electron ; le renderer n'importe jamais le main.

Sécurité du cockpit : `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP stricte ; jeton GitHub uniquement dans `safeStorage`.

Dépôts publics par défaut (minutes Actions gratuites et illimitées) : **seuls les événements dont l'auteur est le propriétaire du dépôt déclenchent quoi que ce soit** (issues, commentaires, réponses, dispatch). Tout autre auteur est ignoré et tracé. Les workflows venant de forks exigent une approbation et n'ont jamais accès aux secrets.

Sécurité des workflows : permissions minimales par job (`permissions:` explicite), jamais `pull_request_target` avec checkout du code de la PR, aucun push direct sur `main`, secrets jamais affichés.

## Règles de travail

- Une tâche = une branche `task/Txx-<slug>` = une PR. Commits Conventional Commits.
- Lire le fichier de tâche en entier avant de coder. Respecter son « Hors périmètre ».
- Si une spécification est ambiguë ou contredit ce fichier ou le cadrage : s'arrêter et poser la question.
- Ne jamais désactiver, sauter (`.skip`, `.only`) ou affaiblir un test existant sans accord explicite.
- Ne jamais committer de secret.
- Textes d'interface et messages aux utilisateurs en français.

## Définition de terminé (commune)

- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run depcruise`, `npm run build` passent
- [ ] Les workflows modifiés passent actionlint
- [ ] Les tests listés dans la tâche existent et passent
- [ ] Couverture ≥ 80 % des lignes sur le code ajouté hors `desktop/renderer`, sans baisse globale
- [ ] Tout bug corrigé a son test de non-régression
- [ ] Tout nouveau contrat a son schéma zod et des tests de validation (cas valides ET invalides)
- [ ] La PR décrit ce qui a été fait, les choix, et comment tester

## Commandes

```
npm run dev -w desktop     # cockpit en développement
npm test                   # unitaires
npm run test:integration   # intégration (réseau simulé ou réel selon la config)
npm run test:e2e           # Playwright Electron
npm run lint
npm run typecheck
npm run depcruise
npm run build
```
