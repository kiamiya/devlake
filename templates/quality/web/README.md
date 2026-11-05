# Profil qualité « web »

Stack de référence : React + Supabase (Vitest, Testing Library, Playwright).

La tâche bootstrap (profil architecte) copie `ci.yml` dans `.github/workflows/ci.yml` du projet et adapte les commandes à la stack. Les noms de jobs sont les checks obligatoires de `main` : ils ne changent pas. Tant qu’ils ne sont pas tous verts sur `main`, le dispatcher ne lance aucune autre tâche.

Les checks `agentlake / tests-guard` et `agentlake / review` viennent du workflow d’appel `agentlake-review.yml` (porte qualité d’AgentLake) : ils ne sont pas dans ce gabarit.

## Règles communes

- Couverture : 80 % des lignes du code métier au minimum.
- Régression : la suite complète tourne sur chaque PR et chaque merge ; tout bug corrigé ajoute un test qui le reproduit.
- Aucun job vidé, sauté ou rendu non bloquant (`continue-on-error` interdit).

## Notes du profil

- `unit-tests` : Vitest et Testing Library, couverture v8 ≥ 80 % des lignes du code métier (`coverage.thresholds.lines: 80`).
- `integration-tests` : Supabase local dans le runner ; règles RLS testées par pgTAP (`supabase test db`).
- `e2e` : Playwright ; captures de régression visuelle et accessibilité (axe) dans les mêmes tests.
- Lighthouse en CI : à ajouter comme étape de `e2e` quand l’application a des pages publiques.
