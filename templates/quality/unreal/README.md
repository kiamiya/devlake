# Profil qualité « unreal »

Stack de référence : Unreal (Automation Spec, Functional Tests, Gauntlet).

La tâche bootstrap (profil architecte) copie `ci.yml` dans `.github/workflows/ci.yml` du projet et adapte les commandes à la stack. Les noms de jobs sont les checks obligatoires de `main` : ils ne changent pas. Tant qu’ils ne sont pas tous verts sur `main`, le dispatcher ne lance aucune autre tâche.

Les checks `agentlake / tests-guard` et `agentlake / review` viennent du workflow d’appel `agentlake-review.yml` (porte qualité d’AgentLake) : ils ne sont pas dans ce gabarit.

## Règles communes

- Couverture : 80 % des lignes du code métier au minimum.
- Régression : la suite complète tourne sur chaque PR et chaque merge ; tout bug corrigé ajoute un test qui le reproduit.
- Aucun job vidé, sauté ou rendu non bloquant (`continue-on-error` interdit).

## Notes du profil

- Les runners GitHub n’ont pas Unreal : chaque job appelle `scripts/ci/<job>.sh`, à écrire par l’architecte.
- `unit-tests` et `integration-tests` lancent les tests d’automatisation (Automation Spec, Functional Tests) sur l’éditeur du poste, via le pont Aura : UnrealEditor-Cmd tourne sur le clone dédié, au commit exact de la PR, sous le verrou d’éditeur. Le résultat signé par le pont devient le check, avec le détail dans le résumé du job.
- Prérequis sur le poste : cockpit ouvert, tunnel actif (variable `AURA_BRIDGE_URL`), pont Unreal démarré, clone dédié préparé, chemin d’UnrealEditor-Cmd renseigné dans les réglages. Secret `AURA_BRIDGE_SECRET` posé au bootstrap.
- Adapter `AUTOMATION_FILTER` aux noms des tests du projet (`Project.Unit`, `Project.Integration` par défaut ; plusieurs filtres joints par `+`). Un filtre qui ne trouve aucun test fait échouer le check.
- Si l’éditeur est occupé (agent en session), le job patiente ; au-delà de `WAIT_MINUTES`, il échoue.
- En attendant un runner auto-hébergé (hors périmètre), le pont est la seule voie pour exécuter le moteur en CI.
- CodeQL C/C++ en mode `none` (sans build).
