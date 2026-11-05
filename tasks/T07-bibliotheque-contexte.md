# T07 — Bibliothèque de contexte

**Jalon :** J1  
**Dépend de :** T05, T06  
**Branche :** `task/T07-bibliotheque-contexte`

## Objectif

Ajouter, consulter et qualifier les documents d'un projet à tout moment.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/desktop/src/renderer/features/context/`

## Spécifications

1. Liste des documents (rôle, date, taille), glisser-déposer multi-fichiers, aperçu Markdown et images.
2. Changer le rôle, ajouter une note, retirer un document (commit de suppression, avec confirmation).
3. Badge « nouveau contexte » pour les documents ajoutés après validation du plan.
4. Affichage de `.agentlake/decisions.md`.

## Critères d'acceptation

- [ ] Cinq fichiers déposés d'un coup apparaissent avec leur aperçu et sont versés en un commit.

## Tests exigés

- Composants ; E2E de glisser-déposer.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Édition du contenu des documents.
