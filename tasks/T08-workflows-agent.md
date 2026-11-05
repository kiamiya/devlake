# T08 — Workflows réutilisables et workflow d'agent

**Jalon :** J1  
**Dépend de :** T01  
**Branche :** `task/T08-workflows-agent`

## Objectif

Écrire le workflow qui exécute un agent Claude Code sur une tâche, socle de tout le reste.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `.github/workflows/agent-task.yml`, `packages/dispatcher/src/agent-context/`

## Spécifications

1. `agent-task.yml` (`workflow_call` et `workflow_dispatch`) : entrées `issue_number`, `profile`, `attempt`, `resume_reason` ; checkout, préparation du contexte, exécution de `anthropics/claude-code-action@v1` en mode automatisation avec `claude_code_oauth_token`.
2. Script de préparation : construit le prompt à partir du profil, du corps de l'issue, de `.agentlake/context/`, `decisions.md`, du `CLAUDE.md` du projet, et, en reprise, de la réponse reçue ou des journaux d'échec CI.
3. Branche `task/<Txx>-<slug>` créée ou reprise ; à la fin : push, PR ouverte ou mise à jour avec description générée, auto-merge demandé.
4. Labels mis à jour en début (`running`) et en fin de job ; en cas d'erreur, label `fixing` et commentaire de diagnostic.
5. Permissions minimales explicites ; timeout de job configurable ; groupe de concurrence `agentlake-task-<issue>` ; artefacts : transcription et journaux.
6. Modèle et outils autorisés lus depuis le profil, jamais codés en dur.

## Critères d'acceptation

- [ ] Sur un dépôt bac à sable, une issue de test « ajouter une fonction et son test » aboutit à une PR avec code et test.

## Tests exigés

- Script de préparation : unitaires (construction du prompt par cas : premier passage, reprise après réponse, reprise après échec).
- actionlint sur le workflow.
- `@live` : exécution réelle sur le bac à sable.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Choix des tâches à lancer (T12).
