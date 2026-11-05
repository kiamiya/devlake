# T01 — Schémas partagés

**Jalon :** J1  
**Dépend de :** T00  
**Branche :** `task/T01-schemas-partages`

## Objectif

Définir tous les contrats du système dans `packages/shared` : c'est le langage commun du planificateur, du dispatcher, des agents et du cockpit.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/shared/src/`

## Spécifications

1. `ProjectConfig` (`.agentlake/project.yml`) : type de projet (web, unity, unreal, mobile, tool, backend, script), profil qualité, plafonds, profils retenus, ressources exclusives, pont requis ou non.
2. `ProjectPlan` (`.agentlake/plan.json`) : résumé, hypothèses, épopées, tâches (id stable `Txx`, titre, description, critères d'acceptation, tests exigés par catégorie, profil, complexité S/M/L, zones de code, ressources exclusives, dépendances), profils retenus avec justification, nombre d'agents proposé, jalons. Validations métier : ids uniques, dépendances existantes, graphe acyclique, première tâche = bootstrap Architecte, chaque tâche de code exige au moins un test.
3. `TaskIssue` : rendu Markdown du corps d'une issue de tâche et parseur inverse (aller-retour sans perte), avec bloc de métadonnées caché `<!-- agentlake:task {json} -->`.
4. Labels : constantes `agentlake:task`, `agentlake:state/{queued,ready,running,awaiting-answer,waiting-editor,fixing,escalated}`, `agentlake:profile/*`, avec la table des transitions autorisées.
5. Protocole de questions : rendu et parseur des commentaires `<!-- agentlake:question id=… blocking=… -->` et `<!-- agentlake:answer id=… decision=… -->`.
6. `AgentProfile` : prompt système, outils autorisés, nombre max de tours, modèle, ressources exclusives, coût estimé en minutes.

## Critères d'acceptation

- [ ] Chaque schéma accepte les fixtures valides et rejette les invalides avec un message précis.
- [ ] Rendu puis parsing d'une issue ou d'un commentaire redonne exactement l'objet de départ.

## Tests exigés

- Unitaires : une vingtaine de plans valides et invalides (cycle, dépendance inconnue, tâche sans test…).
- Tests de propriétés (fast-check) sur l'aller-retour rendu/parsing.
- Régression : snapshots des rendus Markdown.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Appels GitHub.
