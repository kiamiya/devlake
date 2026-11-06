# Architecture

GitHub est la source de vérité : l'état de chaque tâche vit dans son issue (labels, bloc caché), le plan et le contexte dans le dépôt du projet. Aucun agent ne tourne sur le poste ; le cockpit pilote et affiche.

## Paquets

| Paquet        | Rôle                                                                                           | Peut dépendre de                                    |
| ------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `shared`      | Schémas zod et contrats : plan, tâches, questions, profils, qualité, jeton du pont             | rien                                                |
| `github`      | `GitHubPort` : adaptateur Octokit, `FakeGitHub` en mémoire, émulateur HTTP, suite de contrat   | shared                                              |
| `planner`     | Planificateur : questions de cadrage, découpe, validation du plan, publication sur `plan/vN`   | shared, github                                      |
| `dispatcher`  | Passe du dispatcher, contexte et finalisation des agents, porte qualité, CI Unreal par le pont | shared, github                                      |
| `aura-bridge` | Pont MCP vers Aura, verrou d'éditeur, passerelle et tunnel, synchronisation du clone           | shared                                              |
| `desktop`     | Cockpit Electron (main, preload, renderer React)                                               | shared, github, aura-bridge (+ exception de test)   |

Vérifié par dependency-cruiser (`npm run depcruise`) : seul `desktop` importe Electron, le renderer n'importe jamais le main ; `desktop/src/main/testing/` (monde simulé des E2E) peut seul importer `dispatcher` et `planner`, par import dynamique en mode E2E.

## Flux

1. **Bootstrap** (cockpit) : dépôt, réglages, labels, `.agentlake/`, profils, workflows d'appel épinglés sur `kiamiya/devlake@v1`, protection de `main`, secrets.
2. **Planificateur** (`agentlake-planner.yml` → `planner.yml`) : questions dans l'issue Cadrage, puis plan validé par `ProjectPlanSchema` sur `plan/vN`. Le cockpit le valide : plan sur `main`, une issue par tâche, dépendances.
3. **Dispatcher** (`agentlake-dispatcher.yml` → `dispatcher.yml`), à chaque événement du propriétaire et toutes les 10 minutes. Passe pure `planPass` puis application :
   - rattrapage des incohérences (événement manqué) ;
   - dépendances mergées → tâche prête ;
   - capacité `min(C_projet, C_global − agents des autres projets, C_runners)` ;
   - ressources exclusives, pont de l'éditeur, minutes Actions ;
   - jobs morts, CI en échec, escalade, résumé après merge ;
   - garde-fous : pause du projet, pause globale, protection de `main`, checks verts sur `main`.
4. **Agent** (`agentlake-agent-task.yml` → `agent-task.yml`) : `prepare` (branche, prompt, profil, MCP), Claude Code, `finalize` (commit, PR par l'app Claude, auto-merge, questions bloquantes).
5. **Porte qualité** (`agentlake-review.yml` → `review.yml`) : checks `agentlake / tests-guard` et `agentlake / review`, plus la CI du profil qualité. Tous obligatoires sur `main`.

## Données sur GitHub

- Label `agentlake:task`, état `agentlake:state/<état>` (`queued`, `ready`, `running`, `awaiting-answer`, `waiting-editor`, `fixing`, `escalated`).
- Corps de l'issue : bloc `<!-- agentlake:task {…} -->` (la tâche du plan), bloc `<!-- agentlake:dispatch {…} -->` (tentatives, lancements, échec traité, résumé).
- Questions et réponses : commentaires au format du protocole (`shared/questions.ts`) ; seules les réponses du propriétaire comptent.
- `devlake-config/config.yml` (dépôt privé de Kia) : plafond global, pause globale, liste des projets.

## Cockpit

- Processus principal : services sans dépendance à Electron (`CockpitService`, projets, contexte, plan, questions, tableau de bord, pont, tunnel), cache SQLite (drizzle) reconstructible depuis GitHub, coffre `safeStorage`.
- IPC typé par des schémas zod (`shared/ipc-contract.ts`), renderer React + TanStack Query (sondage 30 s).
- `contextIsolation`, `sandbox`, CSP stricte ; jetons jamais affichés en clair.

## Pont Aura

Un pont par éditeur (ports 8765/8766) derrière une passerelle (8764, `/unity`, `/unreal`) publiée par Tailscale Funnel ou Cloudflare Tunnel. Jeton signé (HMAC, `AURA_BRIDGE_SECRET`) par usage : `mcp` (agent), `health` (dispatcher), `ci` (tests d'automatisation Unreal). Réponses signées, verrou d'éditeur, liste blanche d'outils, journal d'audit, interrupteur.

## Tests

| Niveau        | Commande                   | Contenu                                                                          |
| ------------- | -------------------------- | -------------------------------------------------------------------------------- |
| Unitaires     | `npm test`                 | Réseau interdit, couverture ≥ 80 % des lignes                                    |
| Intégration   | `npm run test:integration` | Émulateur GitHub, vrais dépôts git, pont réel                                    |
| E2E           | `npm run test:e2e`         | Cockpit Playwright, faux GitHub, monde simulé (vrai dispatcher et planificateur) |
| Fumée         | `release.yml`              | Application installée depuis l'installeur                                        |
| `@live`       | `npm run test:live`        | Bacs à sable réels, chaque nuit (`nightly-live.yml`)                             |

Bibliothèque de régression partagée : [`tests/fixtures/regression`](../../tests/fixtures/regression/README.md).
