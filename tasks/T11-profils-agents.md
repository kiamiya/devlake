# T11 — Profils d'agents

**Jalon :** J2  
**Dépend de :** T08  
**Branche :** `task/T11-profils-agents`

## Objectif

Définir les types d'agents comme des fichiers versionnés lus par le workflow d'agent.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `templates/profiles/`, `packages/shared` (chargement)

## Spécifications

1. Profils : Architecte, Frontend, Backend, Données, Mobile, DevOps, QA, Unity, Unreal, Relecteur, Documentation.
2. Chaque profil : prompt système (rôle, conventions, obligation d'écrire les tests, obligation de poser une question bloquante pour toute ambiguïté non couverte, interdiction de modifier les tests existants sans accord), outils autorisés, nombre max de tours, modèle, ressources exclusives, coût estimé.
3. Copiés dans `.agentlake/profiles/` au bootstrap ; un projet peut les surcharger.
4. Profils Unity et Unreal : config MCP pointant vers le pont (URL du tunnel, jeton signé injecté au lancement) et guide des outils Aura.

## Critères d'acceptation

- [ ] Chaque profil passe le schéma ; le workflow d'agent construit la bonne configuration pour chacun.

## Tests exigés

- Validation de schéma ; snapshots des configurations générées par profil.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Édition des profils dans le cockpit.
