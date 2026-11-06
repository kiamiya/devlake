# Dépannage

## Barre d'état

Quatre intégrations, chacune **OK**, **DÉGRADÉ** ou **absente** ; survoler le statut affiche la raison. Vérification au démarrage, puis toutes les 10 minutes.

| Statut                    | DÉGRADÉ signifie                                                                                     | Que faire                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GitHub                    | Jeton refusé ou pas encore vérifié ; chiffrement du système indisponible ; `main` n'est plus protégée sur un projet | Réenregistrer le jeton ; **Relancer le bootstrap** du projet cité (il repose la protection) |
| Pont Aura                 | Pont arrêté sur erreur, Aura ne répond pas                                                           | Vérifier la configuration MCP collée, redémarrer le pont                                    |
| Tunnel                    | Ouverture en échec (fournisseur absent, non connecté) ; interrupteur actionné                        | Installer/connecter Tailscale ou `cloudflared`, rouvrir le tunnel à la main                 |
| Configuration globale     | `devlake-config` absent, illisible ou différent des réglages ; publication en échec ; **pause globale active** | Réenregistrer les réglages ; décocher la pause globale                              |

## Une tâche n'avance pas

| État ou symptôme                          | Cause probable                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Rien ne part, seule la tâche bootstrap    | Checks obligatoires pas encore verts sur `main` : la CI posée par le bootstrap doit passer d'abord.                  |
| Rien ne part du tout                      | Pause du projet ou pause globale ; protection de `main` retirée (alerte dans l'issue Cadrage) ; plafond atteint.     |
| En attente de l'éditeur                   | Pont, tunnel ou éditeur fermés, ou éditeur ouvert sur un autre projet.                                               |
| En attente de réponse                     | Une question bloquante attend dans **Questions** (rappel après 24 h).                                                |
| Escaladée                                 | Trois échecs : répondre à la question d'escalade (« Relancer avec cette consigne… ») ou relancer depuis **Exécution**. |
| Commentaire « État corrigé »              | Le rattrapage du dispatcher a corrigé un état incohérent (événement manqué) : rien à faire.                          |

Le journal du run du dispatcher (Actions → « AgentLake — dispatcher ») explique chaque décision : capacité, raison d'attente, événement ignoré.

## Erreurs fréquentes

- **« Aucun modèle pour le planificateur »** : régler le modèle dans les réglages.
- **« Réglage enregistré dans le cockpit, mais pas dans devlake-config »** : publication en échec (réseau, droit Administration du jeton) ; réenregistrer.
- **Événement ignoré dans le journal du dispatcher** : un compte tiers, une PR de fork ou un événement sans auteur ne déclenchent rien, par sécurité (dépôts publics).
- **Agents de jeu sans pont** : le secret `AURA_BRIDGE_SECRET` est posé au bootstrap d'un projet de jeu ; la variable `AURA_BRIDGE_URL` par le tunnel.
- **Installeur bloqué par SmartScreen ou Gatekeeper** : installeur non signé, voir [installation](installation.md).

## Données locales

Le cockpit garde un cache SQLite (miroir des issues et des runs, historique des questions) dans le dossier de données de l'application (`%APPDATA%\AgentLake` sous Windows, `~/Library/Application Support/AgentLake` sous macOS). Il peut être supprimé sans perte : il est reconstruit depuis GitHub au démarrage suivant. Les jetons sont dans le coffre chiffré du même dossier.
