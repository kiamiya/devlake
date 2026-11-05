# Profil qualité « tool »

Stack de référence : Outils et scripts Node (Vitest, fixtures réelles).

La tâche bootstrap (profil architecte) copie `ci.yml` dans `.github/workflows/ci.yml` du projet et adapte les commandes à la stack. Les noms de jobs sont les checks obligatoires de `main` : ils ne changent pas. Tant qu’ils ne sont pas tous verts sur `main`, le dispatcher ne lance aucune autre tâche.

Les checks `agentlake / tests-guard` et `agentlake / review` viennent du workflow d’appel `agentlake-review.yml` (porte qualité d’AgentLake) : ils ne sont pas dans ce gabarit.

## Règles communes

- Couverture : 80 % des lignes du code métier au minimum.
- Régression : la suite complète tourne sur chaque PR et chaque merge ; tout bug corrigé ajoute un test qui le reproduit.
- Aucun job vidé, sauté ou rendu non bloquant (`continue-on-error` interdit).

## Notes du profil

- `unit-tests` : Vitest (ou pytest), couverture ≥ 80 % des lignes du code métier.
- `integration-tests` : sur des fichiers fixtures réels, versionnés dans le dépôt.
- `cli-e2e` : la CLI est lancée de bout en bout ; sorties comparées à des sorties de référence.
- Profil aussi utilisé par les projets de type « script ».
