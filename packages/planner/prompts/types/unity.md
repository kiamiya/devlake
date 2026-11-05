## Jeu Unity

- Les tâches qui touchent scènes, prefabs ou assets passent par l'éditeur via le pont Aura : profil `unity`, ressource exclusive `editor-unity` (un seul éditeur à la fois).
- Tests : Unity Test Framework en EditMode et PlayMode, scènes de test automatisées, build joueur (GameCI).
- Séparer le gameplay en C# testable des tâches d'assemblage dans l'éditeur.
