# Guide d'utilisation d'AgentLake

AgentLake transforme un brief ou un GDD en plan de tâches que tu valides, puis fait réaliser ces tâches par des agents Claude Code qui tournent dans GitHub Actions. Le cockpit, installé sur ton poste, sert à piloter et à suivre ; aucun agent ne tourne sur le poste, et GitHub reste la source de vérité.

1. [Installation et jetons](installation.md) : installer le cockpit, jeton GitHub, `claude setup-token`, secrets des projets.
2. [Premier projet](premier-projet.md) : créer le dépôt, verser le brief, répondre au cadrage, valider le plan, suivre l'exécution.
3. [Reprendre un projet existant](reprendre-un-projet.md) : dépôt perso ou d'organisation, détection, état des lieux, puis la suite du projet.
4. [Pont Aura et tunnel](pont-et-tunnel.md) : projets Unity et Unreal, éditeur local, tests d'automatisation Unreal.
5. [Dépannage](depannage.md) : statuts DÉGRADÉ, tâches bloquées, erreurs fréquentes.

La documentation technique (architecture, extensions, publication) est dans [`docs/technique/`](../technique/README.md).
