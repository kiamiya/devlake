# Profil qualité « unity »

Stack de référence : Unity (Unity Test Framework, GameCI).

La tâche bootstrap (profil architecte) copie `ci.yml` dans `.github/workflows/ci.yml` du projet et adapte les commandes à la stack. Les noms de jobs sont les checks obligatoires de `main` : ils ne changent pas. Tant qu’ils ne sont pas tous verts sur `main`, le dispatcher ne lance aucune autre tâche.

Les checks `agentlake / tests-guard` et `agentlake / review` viennent du workflow d’appel `agentlake-review.yml` (porte qualité d’AgentLake) : ils ne sont pas dans ce gabarit.

## Règles communes

- Couverture : 80 % des lignes du code métier au minimum.
- Régression : la suite complète tourne sur chaque PR et chaque merge ; tout bug corrigé ajoute un test qui le reproduit.
- Aucun job vidé, sauté ou rendu non bloquant (`continue-on-error` interdit).

## Notes du profil

- Secrets requis : `UNITY_LICENSE`, `UNITY_EMAIL`, `UNITY_PASSWORD` (licence Unity, GameCI).
- `unit-tests` : EditMode ; `playmode-tests` : PlayMode ; `integration-tests` : PlayMode, catégorie `Integration`.
- `typecheck` : compilation des assemblies (catégorie `Compilation`, un test minimal suffit).
- `lint` et `dependency-audit` : scripts `scripts/ci/lint.sh` (dotnet format) et `scripts/ci/dependency-audit.sh` (paquets UPM épinglés) à écrire par l’architecte.
- Scènes et prefabs passent par le pont Aura (profil Unity) ; la CI ne touche pas à l’éditeur du poste.
