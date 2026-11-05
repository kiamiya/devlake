# T23 — Packaging et documentation

**Jalon :** J4  
**Dépend de :** T22  
**Branche :** `task/T23-packaging`

## Objectif

Livrer le cockpit installable et une documentation utilisable.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `electron-builder.yml`, `.github/workflows/release.yml`, `docs/`

## Spécifications

1. Installeurs Windows (NSIS) et macOS (dmg) produits par la CI sur tag, attachés à la release ; signature optionnelle documentée.
2. Publication versionnée des workflows réutilisables (tags `vX.Y.Z`) et procédure de mise à jour des workflows d'appel des projets.
3. Documentation utilisateur : installation, jeton GitHub, `claude setup-token`, premier projet, configuration du pont et du tunnel, dépannage.
4. Documentation technique : architecture, ajout d'un profil d'agent, d'un profil qualité, d'un format de document.

## Critères d'acceptation

- [ ] Un installeur Windows produit par la CI s'installe et lance le cockpit sur une machine propre.

## Tests exigés

- Test de fumée de l'application packagée.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Mise à jour automatique du cockpit.
