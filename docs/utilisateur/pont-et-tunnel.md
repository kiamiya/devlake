# Pont Aura et tunnel (Unity, Unreal)

Les agents de jeu tournent dans GitHub Actions, mais l'éditeur Unity ou Unreal est sur ton poste. Le **pont Aura** relaie le serveur MCP d'Aura vers les agents, à travers un **tunnel** HTTPS ; un seul agent tient l'éditeur à la fois.

## Prérequis

- Aura installé dans l'éditeur, avec son écran **MCP Configuration**.
- Un fournisseur de tunnel : **Tailscale Funnel** (Tailscale installé, Funnel activé sur le compte) ou **Cloudflare Tunnel** (`cloudflared` installé, tunnel rapide sans compte).
- Git et Git LFS.

## Réglages

**Réglages** → **Éditeurs et Aura** :

1. **Dossier des clones d'éditeur** : dossier dédié, distinct de ta copie de travail.
2. **Configuration MCP Aura — Unity / Unreal** : coller tel quel le bloc JSON de l'écran **MCP Configuration** d'Aura.
3. **Chemin d'UnrealEditor-Cmd** (Unreal) : par exemple `C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe`.
4. **Autres serveurs MCP** (facultatif) : sous chaque éditeur, **Ajouter un serveur MCP** pour relayer d'autres serveurs du poste par le même pont, par exemple un serveur Unity MCP ou Unreal MCP. Donner un **nom** (minuscules, ex. `unity`) et coller sa configuration :
   - lancé par le cockpit (stdio) : `{ "command": "uvx", "args": ["mcp-unity"] }` ;
   - déjà lancé par l'éditeur (HTTP, sur le poste seulement) : `{ "url": "http://127.0.0.1:6400/mcp" }`.

## Outils et noms

Les outils de chaque serveur sont proposés aux agents sous la forme `serveur__outil` : `aura__scene_list`, `unity__create_gameobject`… Ils sont à cocher dans la liste blanche du pont (les anciennes listes, sans préfixe, sont rattachées à Aura). Le panneau du pont indique pour chaque serveur s'il est connecté, ou la raison s'il est injoignable ; un serveur injoignable n'empêche pas les autres de fonctionner, mais la barre d'état passe le pont en DÉGRADÉ.

## Mise en route d'un projet de jeu

1. Ouvrir le projet → **Préparer le clone de l'éditeur** : clone (ou mise à jour) dans le dossier des clones, Git LFS.
2. Ouvrir ce clone dans Unity ou Unreal.
3. Panneau **Pont Aura** : **Démarrer le pont Unity** (ou Unreal), puis cocher les outils autorisés (liste blanche vide par défaut : aucun outil n'est ouvert tant que tu ne l'as pas choisi).
4. **Tunnel** : choisir le fournisseur, puis **Ouvrir le tunnel**, ou laisser l'exposition automatique l'ouvrir quand une tâche de jeu est prête ou en cours. L'URL est publiée dans la variable `AURA_BRIDGE_URL` des projets de jeu.

Le **journal d'audit** du pont liste chaque appel d'outil et chaque accès refusé. L'**interrupteur d'arrêt** coupe le tunnel et révoque tous les jetons en cours ; le tunnel ne se rouvre plus tout seul.

## Ce que font les agents

- Avant de lancer une tâche de jeu, le dispatcher vérifie la santé du pont (réponse signée) ; sinon la tâche attend l'éditeur.
- L'agent pousse son code, bascule le clone de l'éditeur sur sa branche (`editor_checkout`), travaille dans l'éditeur par Aura, puis pousse scènes, prefabs et `.meta` (`editor_commit_push`). Un asset sérialisé en binaire, un `.meta` manquant ou un binaire hors Git LFS sont refusés.
- Une tâche de code pur C#/C++ (`needsEditor: false` dans le plan) n'utilise ni le pont ni l'éditeur et avance en parallèle.
- Une seule tâche d'éditeur à la fois par projet (groupe de concurrence `agentlake-editor-<dépôt>`).

## Tests d'automatisation Unreal

Les runners GitHub n'ont pas Unreal : les checks `unit-tests` et `integration-tests` du gabarit Unreal demandent au pont de lancer `UnrealEditor-Cmd` sur le clone dédié, au commit exact de la PR. Le cockpit, le tunnel et le pont Unreal doivent être ouverts ; si l'éditeur est occupé par un agent, le check patiente. Adapter `AUTOMATION_FILTER` dans `.github/workflows/ci.yml` aux noms des tests du projet.
