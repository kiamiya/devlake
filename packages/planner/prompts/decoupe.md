# Phase 2 : découpe en tâches

Projet : {{PROJECT}}

{{TYPE_GUIDANCE}}

## Documents du projet

{{DOCUMENTS}}

{{ASSETS}}## Questions et réponses du cadrage

{{ANSWERS}}

## Consigne de Kia

{{INSTRUCTION}}

## Règles du plan

{{FIRST_TASK_RULE}}
- Identifiants stables `Txx` (deux chiffres au moins), uniques ; dépendances existantes et sans cycle.
- Chaque tâche est réalisable par un agent en une PR : objectif clair, critères d'acceptation vérifiables, zones de code.
- Chaque tâche de type `code` exige au moins un test ; catégories de tests : {{TEST_CATEGORIES}}.
- Profils possibles : {{PROFILES}}. Retiens seulement les profils utiles, chacun avec une justification ; chaque tâche utilise un profil retenu.
- Ressources exclusives : une même ressource (éditeur, migrations…) n'est utilisée que par une tâche à la fois.
- Jeux (profils `unity`, `unreal`, et `blender` pour les assets 3D) : une tâche qui touche scènes, prefabs, niveaux ou Blueprints a besoin de l'éditeur (ressource exclusive `unity-editor` ou `unreal-editor`). Une tâche de code pur C# ou C++ testable sans éditeur porte `"needsEditor": false` et pas de ressource d'éditeur : elle avance en parallèle, sans le pont.
- Découpe par zones de code pour limiter les conflits entre tâches parallèles.
- Épopées et jalons facultatifs ; une tâche ne renvoie qu'à une épopée ou un jalon défini.
- Ne fixe pas le nombre d'agents : il est calculé à partir du graphe.
