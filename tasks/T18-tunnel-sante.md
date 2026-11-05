# T18 — Tunnel, santé du pont et interrupteur

**Jalon :** J3  
**Dépend de :** T17  
**Branche :** `task/T18-tunnel-sante`

## Objectif

Rendre le pont joignable depuis GitHub Actions, de façon sûre et observable.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/aura-bridge/src/tunnel/`, `desktop`

## Spécifications

1. Tunnel HTTPS géré par le cockpit : Tailscale Funnel par défaut (gratuit, sans domaine), Cloudflare Tunnel en adaptateur alternatif derrière le même port ; URL publique stockée en variable de dépôt pour les projets de jeu.
2. Point `/health` signé : pont actif, éditeur ouvert, Aura connecté, projet et branche courants.
3. Le dispatcher (T12) appelle `/health` avant de lancer une tâche de jeu.
4. Interrupteur d'arrêt : coupe le tunnel et révoque les jetons en cours.
5. Le pont n'est exposé que si au moins une tâche de jeu est prête ou en cours (option).

## Critères d'acceptation

- [ ] Depuis un runner GitHub, `/health` répond quand l'éditeur est ouvert et échoue proprement sinon.

## Tests exigés

- Unitaires : contenu de santé, interrupteur ; `@live` : appel depuis un workflow du bac à sable.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Autres fournisseurs de tunnel.
