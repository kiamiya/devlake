# Gabarits posés dans les dépôts de projets

Le bootstrap d'un projet (tâche T05) pose ces fichiers dans chaque dépôt créé par AgentLake.

- `caller/*.yml` : workflows d'appel, copiés dans `.github/workflows/` du projet. Ils appellent les workflows réutilisables du dépôt `kiamiya/devlake` à une version épinglée (réglage « version des workflows » du cockpit, `v1` par défaut).

- `profiles/*.yml` : profils d'agents par défaut (tâche T11), copiés dans `.agentlake/profiles/` du projet s'ils y manquent. Un projet surcharge un profil en modifiant son fichier : le bootstrap ne l'écrase jamais. Les variables `${AURA_BRIDGE_URL}` et `${AURA_BRIDGE_TOKEN}` de la configuration MCP sont remplacées au lancement de l'agent, jamais écrites dans le dépôt.

- `quality/<profil>/` : porte qualité par profil qualité (tâche T14) : `ci.yml` et ses notes. Ce n'est pas le cockpit qui les pose : la tâche bootstrap de chaque plan (profil architecte) les lit dans la copie de devlake du runner, les adapte à la stack et les commite dans sa PR. Les noms de jobs sont les checks obligatoires de `main` (`ciChecksFor` dans `packages/shared/src/quality.ts`) ; les checks `agentlake / tests-guard` et `agentlake / review` viennent du workflow d'appel `agentlake-review.yml`.

Variables remplacées au bootstrap dans les workflows d'appel :

| Variable                 | Valeur                                                |
| ------------------------ | ----------------------------------------------------- |
| `__DEVLAKE_REPOSITORY__` | dépôt des workflows réutilisables (`kiamiya/devlake`) |
| `__DEVLAKE_REF__`        | version épinglée (tag)                                |

Ne pas modifier ces fichiers dans un projet : relancer le bootstrap pour les mettre à jour.
