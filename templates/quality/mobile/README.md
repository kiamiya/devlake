# Profil qualité « mobile »

Stack de référence : React Native / Expo (Jest, Maestro).

La tâche bootstrap (profil architecte) copie `ci.yml` dans `.github/workflows/ci.yml` du projet et adapte les commandes à la stack. Les noms de jobs sont les checks obligatoires de `main` : ils ne changent pas. Tant qu’ils ne sont pas tous verts sur `main`, le dispatcher ne lance aucune autre tâche.

Les checks `agentlake / tests-guard` et `agentlake / review` viennent du workflow d’appel `agentlake-review.yml` (porte qualité d’AgentLake) : ils ne sont pas dans ce gabarit.

## Règles communes

- Couverture : 80 % des lignes du code métier au minimum.
- Régression : la suite complète tourne sur chaque PR et chaque merge ; tout bug corrigé ajoute un test qui le reproduit.
- Aucun job vidé, sauté ou rendu non bloquant (`continue-on-error` interdit).

## Notes du profil

- `unit-tests` : Jest, couverture ≥ 80 % des lignes du code métier.
- `integration-tests` : modules natifs simulés (mocks Jest).
- `build` : `expo prebuild` puis build Android (Gradle) ; build iOS sur un runner macOS si le projet le cible.
- `e2e` : Maestro sur un émulateur Android (`reactivecircus/android-emulator-runner`).
