# Gabarits posés dans les dépôts de projets

Le bootstrap d'un projet (tâche T05) pose ces fichiers dans chaque dépôt créé par AgentLake.

- `caller/*.yml` : workflows d'appel, copiés dans `.github/workflows/` du projet. Ils appellent les workflows réutilisables du dépôt `kiamiya/devlake` à une version épinglée (réglage « version des workflows » du cockpit, `v1` par défaut).

Variables remplacées au bootstrap :

| Variable                 | Valeur                                                |
| ------------------------ | ----------------------------------------------------- |
| `__DEVLAKE_REPOSITORY__` | dépôt des workflows réutilisables (`kiamiya/devlake`) |
| `__DEVLAKE_REF__`        | version épinglée (tag)                                |

Ne pas modifier ces fichiers dans un projet : relancer le bootstrap pour les mettre à jour.
