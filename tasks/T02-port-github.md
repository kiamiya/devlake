# T02 — Port et adaptateur GitHub

**Jalon :** J1  
**Dépend de :** T01  
**Branche :** `task/T02-port-github`

## Objectif

Encapsuler toutes les interactions GitHub derrière un port testable, avec relances et délais, utilisé par le cockpit, le planificateur et le dispatcher.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/github/`

## Spécifications

1. Interface `GitHubPort` : dépôts (création, protection de branche, checks obligatoires, auto-merge activé, merge squash seul), fichiers (lecture, commit de plusieurs fichiers en un commit via l'API Git Data), issues, labels, commentaires, relations de dépendance (natives si disponibles sur le compte, sinon section du corps), PR, checks, runs et journaux, `workflow_dispatch`, secrets de dépôt (chiffrés avec la clé publique, libsodium).
2. Adaptateur Octokit : timeout, relances avec backoff sur 5xx et limites de débit, respect des en-têtes de rate limit, erreurs typées.
3. Doublure en mémoire `FakeGitHub` fidèle (issues, labels, commentaires, PR, checks) pour les tests des autres paquets.
4. Détection de capacités du compte (relations de dépendance, auto-merge) exposée par le port.

## Critères d'acceptation

- [ ] Toutes les méthodes du port sont couvertes par la doublure et l'adaptateur.
- [ ] Une erreur 502 suivie d'un succès est transparente pour l'appelant.

## Tests exigés

- Unitaires : adaptateur contre msw (succès, 4xx, 5xx, rate limit), chiffrement des secrets.
- Contrat : la même suite de tests passe sur `FakeGitHub` et sur l'adaptateur simulé par msw.
- `@live` (intégration, hors CI) : parcours sur un dépôt bac à sable Kiamiya.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Logique métier du dispatcher.
