# T09 — Planificateur

**Jalon :** J1  
**Dépend de :** T06, T08  
**Branche :** `task/T09-planificateur`

## Objectif

Produire un plan validé par schéma à partir des documents, après une phase de questions.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/planner/`, `.github/workflows/planner.yml`

## Spécifications

1. Workflow `planner.yml` déclenché par le cockpit (`workflow_dispatch`) ou par une réponse dans l'issue « Cadrage ».
2. Phase 1, clarification : Claude lit `.agentlake/context/` et publie ses questions dans une issue « Cadrage » au format du protocole de questions ; le job se termine.
3. Phase 2, découpe : quand toutes les questions bloquantes ont une réponse (ou sont marquées « ignorée »), Claude écrit `.agentlake/plan.json` sur une branche `plan/vN`.
4. Validation dans le même job par le schéma `ProjectPlan` et les validations métier ; erreurs renvoyées à Claude, 3 essais au plus ; échec final visible dans l'issue avec la sortie brute.
5. Calcul du nombre d'agents proposé (largeur du graphe, coûts, plafonds) par un script déterministe, pas par le modèle.
6. Prompts versionnés dans `packages/planner/prompts/`, avec un complément par type de projet ; régénération possible avec une consigne libre de Kia.

## Critères d'acceptation

- [ ] Sur un brief de référence, le planificateur pose des questions, puis produit un plan valide sur `plan/v1`.

## Tests exigés

- Unitaires : validateur, calcul du nombre d'agents (graphe linéaire, large, ressources exclusives, plafonds), rendu des prompts (snapshots).
- Intégration : scénario complet avec `FakeGitHub` et une réponse Claude simulée.
- Régression : trois briefs de référence (web, Unity, outil CLI).

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Validation du plan par Kia (T10).
