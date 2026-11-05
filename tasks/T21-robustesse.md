# T21 — Robustesse et garde-fous

**Jalon :** J4  
**Dépend de :** T14  
**Branche :** `task/T21-robustesse`

## Objectif

Rendre le système sûr et résistant aux événements manqués, doublés ou désordonnés.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- Tous les paquets

## Spécifications

1. Revue d'idempotence de chaque traitement d'événement, avec tests de rejeu.
2. Rattrapage : la passe planifiée corrige toute incohérence (label `running` sans run actif, PR mergée avec issue ouverte, attente sans question).
3. Garde-fous de workflows : permissions minimales vérifiées par un test qui lit les YAML, interdiction de `pull_request_target` avec checkout de la PR, protection de `main` vérifiée au démarrage de chaque passe.
4. Tests de sécurité des dépôts publics : un événement venant d'un compte tiers (issue, commentaire, PR de fork) ne déclenche ni agent ni reprise, et aucun secret n'est accessible depuis une PR de fork.
5. Mode pause globale (variable de dépôt de config) respecté par le dispatcher.
6. Statuts DÉGRADÉ explicites dans le cockpit pour chaque intégration.

## Critères d'acceptation

- [ ] Supprimer un événement ou le doubler dans une simulation ne change pas l'état final.

## Tests exigés

- Tests de rejeu et de désordre sur la simulation `FakeGitHub` ; test statique des permissions des workflows.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Haute disponibilité du pont.
