# T00 — Socle du monorepo

**Jalon :** J1  
**Dépend de :** aucune  
**Branche :** `task/T00-socle-monorepo`

## Objectif

Créer le dépôt `devlake` prêt pour un développement professionnel : paquets, outillage, tests et CI opérationnels dès le premier commit.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- Racine, `packages/*` (squelettes vides avec `index.ts` et un test), `.github/workflows/ci.yml`

## Spécifications

1. npm workspaces avec les paquets `shared`, `github`, `planner`, `dispatcher`, `aura-bridge`, `desktop` ; TypeScript strict, ESM, références de projet et `tsc -b`.
2. ESLint strict (typescript-eslint strict-type-checked), Prettier, husky + lint-staged.
3. Vitest : `vitest.config.ts` (unitaires, réseau interdit) et `vitest.integration.config.ts` (fichiers `*.integration.test.ts`), couverture v8 avec seuil 80 %.
4. dependency-cruiser avec les règles de `CLAUDE.md` (dont « seul desktop importe electron »).
5. Workflow `ci.yml` : install, lint, typecheck, test, depcruise, build, actionlint, gitleaks ; sur ubuntu-latest ; job séparé Windows + macOS pour `desktop` (ajouté en T03).
6. README minimal : prérequis, commandes.

## Critères d'acceptation

- [ ] Toutes les commandes de `CLAUDE.md` fonctionnent.
- [ ] Un import interdit entre paquets fait échouer `npm run depcruise`.
- [ ] La CI est verte ; un test cassé volontairement la fait échouer.

## Tests exigés

- Un test trivial par paquet ; un test qui vérifie que le réseau est bloqué en unitaire.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Toute logique métier.
