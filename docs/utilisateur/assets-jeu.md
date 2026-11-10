# Assets d'un projet de jeu

Dans un projet Unity ou Unreal, la section **Assets** du projet sert à choisir les assets du jeu : ceux que tu possèdes déjà, ceux des boutiques (Asset Store, Fab) et ceux des bibliothèques gratuites (Poly Haven, ambientCG). Les assets choisis forment la **bibliothèque du projet** (`.agentlake/assets.json`), que le planificateur et les agents lisent.

## Bibliothèque du projet

Chaque asset y est soit **versé** (ses fichiers sont dans le dépôt, avec leur dossier), soit **à acquérir** (lien de boutique, pas encore dans le dépôt). Pour chacun : origine, licence, dossier, tâche d'intégration. **Retirer** enlève l'asset de la bibliothèque ; les fichiers déjà versés restent dans le dépôt.

Les agents utilisent ces assets plutôt que d'en fabriquer de factices. S'il leur en manque un, ils posent une question bloquante qui le décrit : tu en choisis un ici, puis tu réponds en indiquant où il a été versé.

## Mes assets

**Chercher mes assets** parcourt :

- le cache de l'Asset Store de Unity (les packages téléchargés par « My Assets » du Package Manager) ; emplacement par défaut `%APPDATA%\Unity\Asset Store-5.x` sous Windows, `~/Library/Unity/Asset Store-5.x` sous macOS ;
- le VaultCache du launcher Epic (contenus Fab et Marketplace pour Unreal) ; par défaut `C:\ProgramData\Epic\EpicGamesLauncher\VaultCache` ;
- les dossiers que tu déclares dans **Réglages → Assets possédés** : chaque sous-dossier est un asset, ainsi que chaque fichier reconnu (modèle, texture, son, `.blend`, `.unitypackage`).

Un package Unity n'est proposé que dans un projet Unity, un contenu Unreal que dans un projet Unreal. **Taille** calcule le poids d'un dossier avant de le choisir.

## Boutiques (Asset Store, Fab)

L'Asset Store et Fab n'ont pas d'API publique : colle le **lien** de l'asset, son nom, sa licence et une note sur son usage. Il entre dans la bibliothèque « à acquérir ». Achète-le et télécharge-le toi-même dans l'éditeur (Package Manager → My Assets) ou le launcher Epic, puis choisis-le dans **Mes assets** en indiquant le lien qu'il **remplit** : l'entrée passe à « versé » et garde le lien.

## Bibliothèques gratuites

Poly Haven (modèles, textures, HDRI) et ambientCG (matériaux, HDRI), sous licence CC0 : recherche, choix de la résolution (1K, 2K, 4K), puis versement. Les modèles Poly Haven sont pris en FBX si possible, les textures en PNG de préférence.

## Versement

Un asset est versé **en entier**, en un commit sur `main` :

- **Unity** : un `.unitypackage` est décompressé dans le cockpit, ses fichiers et leurs `.meta` (GUID d'origine) à leur chemin prévu dans `Assets/`, comme un import par l'éditeur ; un dossier, un fichier ou un asset gratuit va dans `Assets/ThirdParty/<asset>/`.
- **Unreal** : un contenu du VaultCache garde ses chemins sous `Content/` (sinon ses références se cassent) ; les sources (FBX, textures, sons) vont dans `SourceArt/ThirdParty/<asset>/`, hors de `Content/`.
- Les binaires partent dans **Git LFS** ; une extension binaire inconnue est ajoutée au `.gitattributes`. Un fichier de plus de 2 Go est refusé (limite de GitHub), et un asset de plus de 500 Mo est signalé (le stockage Git LFS gratuit de GitHub est de 1 Go).

Ensuite, une **tâche d'intégration** est créée (tâche ad hoc à partir de `T500`, profil du moteur) : un agent vérifie l'import dans l'éditeur via le pont (échelle, matériaux, collisions), prépare des prefabs (Unity) ou importe les sources dans `Content/ThirdParty/<asset>` (Unreal), et ajoute l'attribution dans `CREDITS.md` pour une licence CC-BY. Le dispatcher la lance dans les plafonds habituels.

## Licences et dépôt public

Les assets de l'Asset Store, de Fab et la plupart des assets payants ne peuvent pas être redistribués : les verser dans un **dépôt public** les rend visibles de tous. Le cockpit le signale et demande une confirmation explicite avant de verser un asset sous licence restreinte (boutique, propriétaire ou inconnue) dans un dépôt public ; la confirmation est notée dans le résultat. Les assets CC0 et CC-BY sont versés sans avertissement.
