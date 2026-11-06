# Ajouter un profil d'agent

Un profil d'agent décrit un rôle (prompt système, outils, modèle, durée estimée, ressources exclusives). Les profils par défaut sont dans `templates/profiles/<id>.yml`, copiés dans `.agentlake/profiles/` de chaque projet au bootstrap s'ils manquent. Un projet surcharge un profil en modifiant sa copie : c'est le fichier entier qui fait foi.

## Étapes

1. **Identifiant** : ajouter l'id à `PROFILE_IDS` dans `packages/shared/src/ids.ts`. Le schéma `ProfileIdSchema` et le prompt de découpe du planificateur (liste `PROFILES`) le prennent en compte.
2. **Gabarit** : créer `templates/profiles/<id>.yml` sur le modèle des autres :
   - `id`, `model` (alias : `opus` pour les rôles de conception et de relecture, `sonnet` sinon) ;
   - `maxTurns`, `estimatedMinutes` (coût estimé, utilisé quand les minutes Actions sont comptées) ;
   - `exclusiveResources` (ex. `unity-editor`), `allowedTools` ;
   - `mcpServers` seulement pour un profil qui passe par le pont (voir `unity.yml`), avec `${AURA_BRIDGE_URL}` et `${AURA_BRIDGE_TOKEN}` ;
   - `systemPrompt` : rôle, règles propres, puis les **règles communes** recopiées telles quelles (tests, questions bloquantes, français).
   Le fichier est validé par `loadAgentProfile` (`packages/shared/src/agent-profile.ts`).
3. **Cockpit** : le gabarit est intégré au bundle (`import.meta.glob` dans `caller-templates.ts`) et posé par le bootstrap ; aucun code à ajouter.
4. **Modèle par profil** : réglable dans le cockpit (`modelsByProfile`) ; aucun modèle n'est codé en dur.
5. **Tests** : `packages/dispatcher/src/agent-context/profiles.test.ts` charge chaque gabarit et vérifie ses invariants (outils, règles communes) ; mettre à jour les instantanés concernés.

## Profil de jeu

Un profil qui pilote un éditeur porte le nom de cet éditeur dans `EDITORS` (`packages/shared/src/ids.ts` : `unity`, `unreal`, `blender`) : le dispatcher vérifie alors le pont de l'éditeur avant de lancer la tâche, et le workflow l'exécute dans le groupe de concurrence de l'éditeur (`agentlake-editor-<dépôt>` pour le moteur, `agentlake-editor-<dépôt>-blender` pour Blender). Ajouter un éditeur demande aussi son pont (port, chemin de la passerelle, sonde, chemins synchronisés) et sa variable d'URL (`bridgeUrlVariable`).
