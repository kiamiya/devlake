# Prompts du planificateur

Prompts versionnés, rendus par `src/prompts.ts`. Les marqueurs `{{NOM}}` sont remplacés au rendu ; un marqueur inconnu ou non fourni est une erreur.

| Fichier            | Usage                                          |
| ------------------ | ---------------------------------------------- |
| `system.md`        | Prompt système commun                          |
| `clarification.md` | Phase 1 : questions de clarification           |
| `decoupe.md`       | Phase 2 : découpe en tâches                    |
| `correction.md`    | Relance après un plan refusé par le validateur |
| `types/<type>.md`  | Complément par type de projet                  |

Toute modification de prompt change les snapshots de `src/prompts.test.ts` : relire le diff avant de les mettre à jour.
