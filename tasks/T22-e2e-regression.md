# T22 — Suite E2E et bibliothèque de régression

**Jalon :** J4  
**Dépend de :** T15, T16, T21  
**Branche :** `task/T22-e2e-regression`

## Objectif

Prouver le fonctionnement de bout en bout et empêcher toute régression.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `tests/e2e/`, `tests/fixtures/`, workflow nocturne

## Spécifications

1. Scénario simulé (cockpit Playwright + `FakeGitHub` + Claude simulé) : création de projet → import d'un docx → questions → réponses → plan → validation → 5 tâches dont une avec question bloquante et une avec échec CI → toutes mergées → avancement 100 %.
2. Scénario multi-projets avec plafond global respecté.
3. Bibliothèque de régression : briefs de référence, plans attendus, séquences d'événements.
4. Workflow nocturne `@live` sur le dépôt bac à sable Kiamiya, avec rapport.

## Critères d'acceptation

- [ ] Le scénario simulé passe en CI en moins de 15 minutes sur Windows et macOS.

## Tests exigés

- Ceux décrits ci-dessus.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Tests de charge.
