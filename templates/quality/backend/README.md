# Profil qualité « backend »

Stack de référence : API Node (Vitest ; Testcontainers ; contrat OpenAPI).

La tâche bootstrap (profil architecte) copie `ci.yml` dans `.github/workflows/ci.yml` du projet et adapte les commandes à la stack. Les noms de jobs sont les checks obligatoires de `main` : ils ne changent pas. Tant qu’ils ne sont pas tous verts sur `main`, le dispatcher ne lance aucune autre tâche.

Les checks `agentlake / tests-guard` et `agentlake / review` viennent du workflow d’appel `agentlake-review.yml` (porte qualité d’AgentLake) : ils ne sont pas dans ce gabarit.

## Règles communes

- Couverture : 80 % des lignes du code métier au minimum.
- Régression : la suite complète tourne sur chaque PR et chaque merge ; tout bug corrigé ajoute un test qui le reproduit.
- Aucun job vidé, sauté ou rendu non bloquant (`continue-on-error` interdit).

## Notes du profil

- `unit-tests` : Vitest (ou Jest), couverture ≥ 80 % des lignes du code métier.
- `integration-tests` : Testcontainers (Docker est disponible sur les runners Linux).
- `contract-tests` : la spécification OpenAPI fait foi ; requêtes et réponses vérifiées contre elle.
- Stack Python : remplacer les commandes npm par `pytest`, `ruff`, `mypy`, `pip-audit`, et la langue CodeQL par `python`.
