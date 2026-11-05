# T13 — Protocole de questions et décisions

**Jalon :** J2  
**Dépend de :** T12  
**Branche :** `task/T13-questions`

## Objectif

Permettre aux agents de poser des questions, suspendre proprement la tâche, et reprendre avec la réponse.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/dispatcher/src/questions/`, prompts des profils, `agent-task.yml`

## Spécifications

1. Instructions dans les profils pour publier une question au format du protocole et terminer la session si elle est bloquante.
2. Le workflow détecte une question bloquante publiée pendant le job et pose `state/awaiting-answer` au lieu d'ouvrir une PR.
3. Sur `issue_comment` contenant une réponse : le dispatcher vérifie que l'auteur est le propriétaire du dépôt et que l'issue attend bien cet identifiant de question, retire l'attente et relance l'agent avec `resume_reason=answer`. Toute autre réponse est ignorée et tracée dans un commentaire discret.
4. Si la réponse porte `decision=true`, ajout à `.agentlake/decisions.md` par commit.
5. Délai configurable : rappel par notification au bout de 24 h, sans action automatique.

## Critères d'acceptation

- [ ] Question bloquante → label d'attente → réponse → reprise sur la même branche avec la réponse dans le contexte.
- [ ] Une réponse à une ancienne question ne relance rien.

## Tests exigés

- Unitaires : parsing, appariement question/réponse, idempotence.
- Intégration : scénario complet avec `FakeGitHub`.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Interface de réponse (T15).
