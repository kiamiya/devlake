## Jeu Unity

- Les tâches qui touchent scènes, prefabs ou assets passent par l'éditeur via le pont Aura : profil `unity`, ressource exclusive `unity-editor` (un seul éditeur à la fois).
- Tests : Unity Test Framework en EditMode et PlayMode, scènes de test automatisées, build joueur (GameCI).
- Séparer le gameplay en C# testable des tâches d'assemblage dans l'éditeur.
- Assets 3D (modèles, rigs, animations) : tâches du profil `blender` (Artiste 3D), ressource exclusive `blender-editor`, en parallèle des tâches Unity. Livrables : `Art/<asset>/<asset>.blend` et son export FBX dans `Assets/Art/<asset>/` ; la tâche Unity qui intègre l'asset en dépend.
