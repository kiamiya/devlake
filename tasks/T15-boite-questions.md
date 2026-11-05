# T15 — Boîte de questions du cockpit

**Jalon :** J2  
**Dépend de :** T13  
**Branche :** `task/T15-boite-questions`

## Objectif

Centraliser toutes les questions des agents et du planificateur et y répondre vite.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/desktop/src/renderer/features/questions/`

## Spécifications

1. Vue par projet et vue globale : question, contexte (tâche, extraits), bloquante ou non, options proposées, ancienneté.
2. Réponse par option ou texte libre, pièce jointe possible (versée dans le contexte via T06), case « décision du projet » cochée par défaut ; publication au format du protocole.
3. Notifications système et badges à chaque nouvelle question bloquante (sondage de l'API toutes les 30 s).
4. Historique et recherche.

## Critères d'acceptation

- [ ] Répondre depuis le cockpit relance l'agent (constaté via le label `running`).

## Tests exigés

- Composants ; intégration avec `FakeGitHub` ; E2E question → notification → réponse.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- Réponses par d'autres personnes.
