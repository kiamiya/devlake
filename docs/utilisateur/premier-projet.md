# Premier projet

## 1. Créer le projet

**Accueil** (Ctrl+1) → **Nouveau projet** :

- **Visibilité** : public par défaut (minutes Actions gratuites et illimitées). Un dépôt privé est plafonné à 2 000 minutes par mois sur un compte gratuit.
- **Type** : web, backend, mobile, script, Unity, Unreal… Le **profil qualité** (CI imposée) en découle.
- **Nom du dépôt**, puis **Créer le projet**.

Le bootstrap crée le dépôt, règle le merge (squash, auto-merge), restreint le `GITHUB_TOKEN`, pose les labels, `.agentlake/project.yml`, les profils d'agents, les workflows d'appel, protège `main` et pose les secrets. Il est idempotent : **Relancer le bootstrap** remet en place ce qui manque et ne change rien sinon.

Un dépôt déjà bootstrappé s'ouvre par **Ouvrir un dépôt existant**.

## 2. Verser le contexte

Section **Contexte** : déposer le brief, le GDD et les annexes (docx, pdf, html, md, txt, images), ou **Choisir des fichiers**. Chaque document est converti en Markdown, prévisualisé, puis versé dans `.agentlake/context/` en un seul commit. Indiquer le **rôle** (brief, GDD, annexe). Sur un dépôt public, confirmer que les documents peuvent être publics.

## 3. Cadrage : questions du planificateur

Section **Plan** → **Lancer le planificateur**. Il lit le contexte et pose ses questions dans l'issue « Cadrage » du dépôt. Elles arrivent dans **Questions** (notification système pour une question bloquante) :

- choisir une option ou écrire une réponse, puis **Répondre** ; la case « Décision du projet » range la réponse dans `.agentlake/decisions.md` ;
- une question non bloquante peut être ignorée : le planificateur applique son choix par défaut.

Quand toutes les questions bloquantes ont une réponse, le planificateur écrit le plan sur une branche `plan/vN`.

## 4. Valider le plan

Section **Plan** → **Revue du plan** : arborescence, graphe des dépendances, équipe proposée (nombre d'agents), comparaison entre versions. Ajuster une tâche est revalidé aussitôt (une dépendance circulaire est refusée) ; **Régénérer le plan** prend une consigne libre.

**Valider le plan** → **Confirmer la validation** : le plan part sur `main`, une issue est créée par tâche avec ses dépendances, et le dispatcher démarre. La validation est idempotente.

## 5. Suivre l'exécution

- **Exécution** : avancement pondéré (S = 1, M = 2, L = 3), kanban par état, PR de chaque tâche, **Mettre en pause** le projet, relance d'une tâche escaladée avec une consigne.
- **Runs** : runs d'agent, journal (virtualisé), transcription de la session.
- **Questions** : questions bloquantes des agents en cours de tâche ; la réponse relance l'agent sur sa branche.

Le cycle d'une tâche : en file → prête (dépendances mergées) → en cours (agent lancé) → PR avec CI, garde des tests et relecture → merge automatique → issue fermée et résumée. Une CI en échec renvoie l'agent corriger ; après 3 échecs (réglable), la tâche est escaladée et une question t'est posée.

Seule la tâche de bootstrap (architecte) part tant que les checks obligatoires de la CI ne sont pas verts sur `main`.
