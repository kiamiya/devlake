# Installation et jetons

## Installer le cockpit

Les installeurs sont attachés à chaque release du dépôt `kiamiya/devlake` (page **Releases**, version `vX.Y.Z`).

| Système                   | Fichier                          | Installation                                                                                       |
| ------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Windows 10/11 (x64)       | `AgentLake-X.Y.Z-setup.exe`      | Lancer l'installeur ; installation pour l'utilisateur courant, dossier modifiable.                 |
| macOS (Apple Silicon)     | `AgentLake-X.Y.Z-arm64.dmg`      | Ouvrir le dmg et glisser **AgentLake** dans **Applications**.                                      |
| macOS (Intel)             | `AgentLake-X.Y.Z-x64.dmg`        | Idem.                                                                                              |

Les installeurs ne sont pas signés tant qu'aucun certificat n'est configuré (voir [publication](../technique/publication.md)) :

- **Windows** : SmartScreen affiche « Windows a protégé votre ordinateur ». Cliquer **Informations complémentaires**, puis **Exécuter quand même**.
- **macOS** : Gatekeeper refuse d'ouvrir l'application. Clic droit sur **AgentLake** dans Applications, **Ouvrir**, puis confirmer ; ou, dans un terminal : `xattr -dr com.apple.quarantine /Applications/AgentLake.app`.

La mise à jour se fait en installant la nouvelle version par-dessus : les réglages et le cache local sont conservés (dossier de données de l'application).

## Mettre à jour le cockpit

Le cockpit cherche une nouvelle version au démarrage puis toutes les 6 heures (et sur **Réglages → Mises à jour du cockpit → Vérifier maintenant**). Une version disponible s'annonce dans un **bandeau** au-dessus des onglets, avec ses nouveautés ; le refermer le masque jusqu'à la version suivante.

- **Windows** : **Télécharger** (progression affichée), puis **Redémarrer pour mettre à jour**. Sans redémarrage, la mise à jour s'installe à la fermeture du cockpit.
- **macOS** : l'installeur n'étant pas signé, la mise à jour automatique n'est pas possible : **Télécharger** enregistre le `.dmg` de ton processeur dans Téléchargements, **Ouvrir l'installeur** l'ouvre ; glisse AgentLake dans Applications en remplaçant l'ancienne version, puis relance le cockpit.

Réglages, cache et secrets sont conservés. Les agents tournent sur GitHub : mettre à jour le cockpit n'interrompt aucune tâche.

## Jeton GitHub

Le cockpit agit sur GitHub avec un jeton personnel, gardé chiffré par le système (`safeStorage` : Trousseau macOS, DPAPI Windows). Il n'est jamais affiché en clair, ni écrit dans un dépôt.

Créer un **jeton à portée fine** (Settings → Developer settings → Fine-grained tokens) :

- Propriétaire : ton compte. Dépôts : **All repositories** (le cockpit crée les dépôts des projets et `devlake-config`).
- Permissions de dépôt :

| Permission      | Accès      | Utilisée pour                                                                       |
| --------------- | ---------- | ----------------------------------------------------------------------------------- |
| Administration  | Read/write | Création des dépôts, réglages de merge, protection de `main`, permissions Actions   |
| Contents        | Read/write | Contexte, plan, fichiers posés au bootstrap                                         |
| Workflows       | Read/write | Workflows d'appel posés au bootstrap                                                |
| Issues          | Read/write | Issues de tâches, questions et réponses, issue Cadrage                              |
| Pull requests   | Read       | Suivi des PR d'agents dans le tableau de bord                                       |
| Actions         | Read/write | Lancement du planificateur et du dispatcher, runs, journaux, relances               |
| Secrets         | Read/write | Secrets des projets (`CLAUDE_CODE_OAUTH_TOKEN`, `AURA_BRIDGE_SECRET`)               |
| Variables       | Read/write | Variables des projets (`AURA_BRIDGE_URL`, `AGENTLAKE_PAUSED`)                       |
| Metadata        | Read       | Obligatoire                                                                         |

Dans le cockpit : **Réglages** → **Nouveau jeton GitHub** → **Enregistrer le jeton GitHub**. La barre d'état passe à **GitHub OK** (« Connecté en tant que … »).

## Jeton Claude Code (`claude setup-token`)

Les agents tournent avec ton abonnement Claude, par un jeton OAuth longue durée :

1. Installer Claude Code sur le poste : `npm install --global @anthropic-ai/claude-code`.
2. Lancer `claude setup-token`, se connecter dans le navigateur, copier le jeton affiché (`sk-ant-oat01-…`).
3. Cockpit : **Réglages** → **Nouveau jeton Claude Code** → **Enregistrer le jeton Claude**.

Le cockpit pose ce jeton dans le secret `CLAUDE_CODE_OAUTH_TOKEN` de chaque nouveau projet au bootstrap.

## Réglages à faire une fois

- **Modèle du planificateur** et modèles par profil : aucun modèle n'est codé en dur.
- **Agents simultanés (plafond global)** : C_global, appliqué au total de tous les projets ; publié dans le dépôt privé `devlake-config` avec la liste des projets.
- **Pause globale** : aucun agent lancé, tous projets confondus (les agents en cours finissent).
- **Version des workflows devlake** : `v1` par défaut (tag majeur, voir [publication](../technique/publication.md)).

## Secrets à créer à la main dans chaque projet

| Secret                     | Obligatoire | Rôle                                                                                                                                     |
| -------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTLAKE_CONFIG_TOKEN`   | conseillé   | Jeton à portée fine : **Contents: read** sur `devlake-config`, **Actions: read** sur les dépôts des projets. Sans lui, plafond par défaut (3) appliqué par projet. |
| `AGENTLAKE_BILLING_TOKEN`  | non         | Dépôt privé seulement : minutes Actions restantes (permission utilisateur **Plan: read**). Sans lui, pas de bridage par les minutes.     |

Installer aussi l'**app GitHub Claude** sur les dépôts des projets : son jeton ouvre les PR des agents, ce qui déclenche la CI (une PR ouverte avec le jeton du job ne la déclencherait pas).
