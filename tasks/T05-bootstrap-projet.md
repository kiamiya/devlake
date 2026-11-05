# T05 — Création de projet et bootstrap du dépôt

**Jalon :** J1  
**Dépend de :** T02, T04  
**Branche :** `task/T05-bootstrap-projet`

## Objectif

Créer un projet complet sur GitHub en quelques clics, prêt à recevoir le planificateur et les agents.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/desktop/src/main/services/projects/`, `templates/`

## Spécifications

1. Assistant : nom, type, visibilité du dépôt (**public par défaut**, privé en option avec rappel du quota de 2 000 minutes par mois), profil qualité par défaut selon le type. Avertissement explicite avant de verser un brief dans un dépôt public.
2. Bootstrap via `GitHubPort` : création du dépôt, `.agentlake/project.yml`, workflows d'appel (`templates/caller/*.yml`) qui référencent les workflows réutilisables de `devlake` à une version épinglée, labels `agentlake:*`, protection de `main` (PR obligatoire, checks obligatoires listés par le profil qualité, merge squash, auto-merge activé), Git LFS configuré pour les binaires. Réglages Actions du dépôt : approbation obligatoire des workflows de PR venant de forks, permissions par défaut du `GITHUB_TOKEN` en lecture seule.
3. Secrets : `CLAUDE_CODE_OAUTH_TOKEN` (saisi une fois dans le cockpit, gardé dans `safeStorage`, poussé dans chaque nouveau dépôt), `AURA_BRIDGE_SECRET` pour les projets de jeu.
4. Idempotent : relancer le bootstrap sur un dépôt partiellement configuré complète sans dupliquer.
5. Ouverture du projet dans un nouvel onglet.

## Critères d'acceptation

- [ ] Un projet web créé a tous les éléments ci-dessus visibles sur GitHub.
- [ ] Relancer le bootstrap ne change rien de plus.

## Tests exigés

- Intégration avec `FakeGitHub` : bootstrap complet, idempotence, échec partiel puis reprise.
- Validation : les workflows d'appel générés passent actionlint.
- E2E : parcours de l'assistant.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Contenu de la CI applicative (T14).
