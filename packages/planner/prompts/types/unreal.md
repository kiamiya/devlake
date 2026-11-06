## Jeu Unreal

- Les tâches qui touchent niveaux, Blueprints ou assets passent par l'éditeur via le pont Aura : profil `unreal`, ressource exclusive `unreal-editor`.
- Tests : Automation Spec, Functional Tests, Gauntlet.
- Séparer le C++ testable des tâches d'assemblage dans l'éditeur.
- Assets 3D (modèles, rigs, animations) : tâches du profil `blender` (Artiste 3D), ressource exclusive `blender-editor`, en parallèle des tâches Unreal. Livrables : `Art/<asset>/<asset>.blend` et son export FBX à côté ; une tâche Unreal dépendante l'importe dans Content.
