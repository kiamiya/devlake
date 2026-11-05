# T17 — Pont Aura

**Jalon :** J3  
**Dépend de :** T03  
**Branche :** `task/T17-pont-aura`

## Objectif

Permettre aux agents qui tournent dans GitHub Actions d'utiliser le MCP d'Aura qui tourne sur le poste.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/aura-bridge/`, intégration dans `desktop`

## Spécifications

1. Lancement du serveur MCP Aura en stdio avec la commande et les arguments des réglages (`aura-unity` ou `aura`).
2. Réexposition en MCP HTTP (Streamable HTTP) sur 127.0.0.1, port configurable.
3. Authentification : jeton `base64(payload).hmac` avec `AURA_BRIDGE_SECRET`, payload = dépôt, run id, expiration ; comparaison à temps constant ; refus après expiration.
4. Liste blanche des outils Aura par profil ; appels hors liste refusés.
5. Journal d'audit de chaque appel (run, outil, durée, résultat) visible dans le cockpit.
6. Un seul client actif à la fois par éditeur ; les appels concurrents sont refusés avec une erreur explicite.
7. Interface du cockpit : démarrer, arrêter, état, dernier appel.

## Critères d'acceptation

- [ ] Un client MCP avec un jeton valide liste et appelle les outils autorisés ; un jeton expiré ou falsifié est refusé.

## Tests exigés

- Unitaires : signature, expiration, liste blanche, exclusivité.
- Intégration : pont contre un faux serveur MCP Aura stdio.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Tunnel (T18), synchronisation (T19).
