# T10 — Revue et validation du plan

**Jalon :** J1  
**Dépend de :** T04, T09  
**Branche :** `task/T10-revue-plan`

## Objectif

Permettre à Kia de lire, ajuster et valider le plan avant tout lancement, puis créer les issues.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/desktop/src/renderer/features/plan-review/`, `packages/desktop/src/main/services/plan/`

## Spécifications

1. Lecture de `plan.json` depuis la branche `plan/vN` ; vue arborescente et graphe des dépendances (React Flow), couleurs par profil.
2. Panneau Équipe : profils retenus, nombre d'agents proposé et détail du calcul ; plafond projet modifiable.
3. Édition des tâches (titre, critères, tests, profil, dépendances) avec revalidation immédiate par le schéma partagé ; cycle refusé.
4. Comparaison de deux versions de plan.
5. « Valider le plan » : merge de `plan/vN`, création d'une issue par tâche (corps `TaskIssue`, labels `agentlake:task` et `state/queued`, profil), relations de dépendance, puis déclenchement du dispatcher. Opération idempotente.

## Critères d'acceptation

- [ ] Valider crée exactement les issues et dépendances affichées ; relancer la validation n'en crée pas de nouvelles.

## Tests exigés

- Composants ; intégration avec `FakeGitHub` (création, idempotence) ; E2E brief → questions → plan → validation.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Lancement des agents (T12).
