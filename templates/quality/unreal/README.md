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
- Les tests d’automatisation passent par le pont, sur l’éditeur du poste, et sont publiés comme checks (tâche T20 du kit) ; en attendant, les scripts vérifient ce qui tourne sans moteur (format clang, structure, compilation de modules isolés).
- CodeQL C/C++ en mode `none` (sans build).
