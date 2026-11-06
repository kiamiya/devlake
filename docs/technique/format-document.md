# Ajouter un format de document

Le cockpit convertit chaque document versé dans le contexte en Markdown normalisé, avec ses images extraites dans `.agentlake/context/assets/`. Un parseur par format, enregistré dans le registre.

## Étapes

1. **Parseur** : dans `packages/desktop/src/main/services/ingestion/parsers/`, implémenter `DocumentParser` (`ingestion/types.ts`) :

   ```ts
   export const odtParser: DocumentParser = {
     id: 'odt',
     extensions: ['odt'], // minuscules, sans point
     async parse(file) {
       // file.name, file.data (Uint8Array)
       return { markdown, images, warnings };
     },
   };
   ```

   - `images` : `{ name, data, mimeType }`, le nom étant l'empreinte du contenu et son extension ; le Markdown y renvoie par `assets/<nom>`.
   - `warnings` : messages pour Kia (ex. « OCR nécessaire »), affichés dans l'aperçu.
   - Le Markdown passe ensuite par la normalisation commune (`ingestion/markdown.ts`).

2. **Registre** : ajouter `.register(odtParser)` dans `defaultRegistry()` (`ingestion/registry.ts`). Le sélecteur de fichiers et le glisser-déposer acceptent alors l'extension, et le message de `UnsupportedFormatError` doit citer le nouveau format.
3. **Tests** : ajouter un fichier d'exemple dans `ingestion/__fixtures__/` (générateur : `packages/desktop/scripts/generate-ingestion-fixtures.ts`) et ses cas dans `parsers.test.ts` (Markdown attendu en instantané, images, avertissements, fichier corrompu).

Les fichiers importés gardent leur rôle (brief, GDD, annexe, asset) et leur empreinte dans `.agentlake/context/context.json` : un réimport identique ne change rien.
