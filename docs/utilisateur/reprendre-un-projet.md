# Reprendre un projet existant

AgentLake peut continuer un projet qui existe déjà sur GitHub, qu'il ait été commencé à la main ou ailleurs : développement classique (web, backend, mobile, outil) ou jeu vidéo (Unity, Unreal, avec Blender et Aura). Le code existant n'est jamais réécrit par la reprise elle-même : le cockpit prépare le dépôt, le planificateur fait un état des lieux, puis planifie seulement ce qui reste à faire.

## 1. Choisir le dépôt

Accueil → **Reprendre un projet existant**. La liste montre les dépôts que tu administres : les tiens et ceux des organisations où tu es administrateur du dépôt (droits nécessaires pour protéger `main` et poser les secrets). Les dépôts archivés et ceux déjà ouverts dans le cockpit n'y sont pas. **Analyser** lance la détection ; rien n'est modifié à ce stade.

## 2. Lire le rapport de détection

- **Type et profil qualité** : proposés d'après le dépôt (Unity : `ProjectSettings/ProjectVersion.txt` ; Unreal : un `.uproject` ; web : `package.json` ; mobile, backend, outil sinon). Tu peux les changer.
- **Blocages** : la reprise est refusée tant qu'ils existent.
  - Projet Unity ou Unreal dans un sous-dossier : seul un projet à la racine du dépôt est pris en charge ; le déplacer à la racine d'abord.
  - Branche par défaut autre que `main` alors qu'une branche `main` existe déjà : la supprimer ou la renommer.
- **Réglages qui vont changer** : à accepter (case à cocher) avant la reprise.
  - Branche par défaut renommée en `main` (GitHub redirige l'ancien nom et repointe les PR ouvertes ; dans chaque clone local : `git branch -m <ancien> main`, `git fetch`, `git branch -u origin/main main`).
  - Merge squash seul, auto-merge, suppression des branches fusionnées.
  - Relectures humaines exigées sur `main` ramenées à 0 : les agents fusionnent seuls une fois les checks verts.
  - `GITHUB_TOKEN` des workflows en lecture seule par défaut.
- **Ce qui est gardé** : les workflows existants, les checks déjà exigés sur `main` (la porte qualité s'y ajoute), les issues et PR ouvertes (jamais modifiées), le `.gitattributes` (les règles Git LFS manquantes sont ajoutées à la fin).
- **Fichiers lourds hors Git LFS** : ils restent tels quels ; seuls les nouveaux fichiers iront dans LFS. Les clones existants peuvent les voir comme modifiés : `git add --renormalize .` les migrera plus tard, si tu le souhaites.
- **MCP** : pour un jeu, indique si le MCP du moteur (Aura…) et le MCP Blender sont configurés dans les Réglages du cockpit. Voir [Pont Aura et tunnel](pont-et-tunnel.md).

**Reprendre le projet** lance le bootstrap en mode reprise (comme pour un nouveau projet, sans créer le dépôt), pose la variable `AGENTLAKE_OWNER` (ton compte : dans un dépôt d'organisation, c'est toi qui réponds aux agents et lances le planificateur, pas l'organisation) et ouvre le projet dans un onglet.

## 3. État des lieux

Onglet du projet → **Plan** → **Lancer l'état des lieux** (consigne facultative). Le planificateur parcourt le dépôt en lecture seule : stack et version du moteur, structure et conventions, tests et CI, assets (scènes, `.blend` et exports, binaires hors LFS), ce qui marche et ce qui est inachevé, issues et PR ouvertes, risques. Il écrit le document sur une branche `etat-des-lieux/vN`.

Relis-le dans la carte **État des lieux**, refais-le au besoin (nouvelle version), puis **Valider** : il est versé dans le contexte (`.agentlake/context/etat-des-lieux.md`) et sert au cadrage, au plan et à tous les agents. Le planificateur refuse de planifier un projet repris tant que l'état des lieux n'est pas validé.

## 4. Brief, cadrage et plan

Le brief (ou le GDD) est **facultatif** : verse-le dans **Contexte** si tu as des objectifs écrits pour la suite. Sans brief, le planificateur pose ses questions de cadrage sur la suite à donner, à partir de l'état des lieux.

Le plan d'un projet repris commence par `T00` **audit et remise au vert** (architecte) : rendre la CI du projet verte sur `main`, ajouter les checks de la porte qualité sans remplacer la CI existante, noter les conventions constatées dans `decisions.md`, sans réécrire l'existant. Comme pour un nouveau projet, les autres tâches attendent que `main` soit vert. Les tâches suivantes ne couvrent que ce qui reste à faire, respectent la structure existante et citent les issues ou PR qu'elles reprennent.

La suite est identique à un [premier projet](premier-projet.md) : validation du plan, exécution, questions, tâches ad hoc.

## Projets bootstrappés avant la reprise

Les projets créés avant cette version n'ont pas la variable `AGENTLAKE_OWNER` ni le mode `inventory` du planificateur : **Relancer le bootstrap** les ajoute. Ce n'est nécessaire que pour un dépôt d'organisation, ou pour faire un état des lieux.
