# Phase 2 : découpe en tâches

Projet : {{PROJECT}}

{{TYPE_GUIDANCE}}

## Documents du projet

{{DOCUMENTS}}

## Questions et réponses du cadrage

{{ANSWERS}}

## Consigne de Kia

{{INSTRUCTION}}

## Règles du plan

- La première tâche (`T00`) est le bootstrap du dépôt par le profil `architect`, sans dépendance : structure, conventions, CI complète.
- Identifiants stables `Txx` (deux chiffres au moins), uniques ; dépendances existantes et sans cycle.
- Chaque tâche est réalisable par un agent en une PR : objectif clair, critères d'acceptation vérifiables, zones de code.
- Chaque tâche de type `code` exige au moins un test ; catégories de tests : {{TEST_CATEGORIES}}.
- Profils possibles : {{PROFILES}}. Retiens seulement les profils utiles, chacun avec une justification ; chaque tâche utilise un profil retenu.
- Ressources exclusives : une même ressource (éditeur, migrations…) n'est utilisée que par une tâche à la fois.
- Découpe par zones de code pour limiter les conflits entre tâches parallèles.
- Épopées et jalons facultatifs ; une tâche ne renvoie qu'à une épopée ou un jalon défini.
- Ne fixe pas le nombre d'agents : il est calculé à partir du graphe.
