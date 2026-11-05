# T14 — Porte qualité et merge automatique

**Jalon :** J2  
**Dépend de :** T12  
**Branche :** `task/T14-porte-qualite`

## Objectif

Garantir qu'aucune tâche n'est mergée sans que tous les tests passent, et corriger automatiquement les échecs.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `templates/quality/`, `.github/workflows/review.yml`, `packages/dispatcher/src/quality/`

## Spécifications

1. Profils qualité par type (web, backend, mobile, tool, script, unity, unreal) conformes au cadrage : workflows CI, configs de lint et couverture, gitleaks, CodeQL, liste des checks obligatoires.
2. `review.yml` : relecture de chaque PR par Claude (profil Relecteur), verdict publié comme check obligatoire ; changements demandés → tâche en `fixing`.
3. Check « tests modifiés » : toute modification ou suppression d'un test existant fait échouer le check et publie une question bloquante sur l'issue.
4. Check « tests ajoutés » : une PR qui touche du code applicatif sans ajouter ni modifier de test échoue.
5. Échec de CI : le dispatcher relance l'agent avec les extraits pertinents des journaux ; après N échecs, `state/escalated` et question.
6. Après merge : issue fermée par la PR, dispatcher déclenché pour débloquer la suite, résumé de la tâche en commentaire (fichiers, tests ajoutés, tentatives, durée, minutes).
7. La tâche bootstrap de chaque plan pose ces gabarits ; le dispatcher ne débloque rien tant que les checks obligatoires ne sont pas en place.

## Critères d'acceptation

- [ ] Un test qui échoue en CI déclenche une correction puis un merge automatique.
- [ ] Une PR qui supprime un test existant ne peut pas être mergée sans réponse de Kia.

## Tests exigés

- Unitaires : détection des modifications de tests dans un diff, extraction des journaux.
- actionlint et snapshots de chaque gabarit.
- Intégration : scénarios succès, échec puis succès, 3 échecs puis escalade, test supprimé.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Déploiement des projets.
