/**
 * Génère les workflows d'appel tels que le bootstrap les pose dans un projet,
 * pour les faire vérifier par actionlint en CI.
 * Usage : npx tsx packages/desktop/scripts/generate-callers.ts <dossier>
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVLAKE_REPOSITORY, renderCallers } from '../src/main/services/projects/files.js';

const out = resolve(process.argv[2] ?? '.generated/callers');
const templatesDir = fileURLToPath(new URL('../../../templates/caller', import.meta.url));

const templates = Object.fromEntries(
  readdirSync(templatesDir)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => [name, readFileSync(join(templatesDir, name), 'utf8')]),
);

mkdirSync(out, { recursive: true });
for (const [path, content] of renderCallers(templates, {
  repository: DEVLAKE_REPOSITORY,
  ref: 'v1',
})) {
  writeFileSync(join(out, basename(path)), content);
}
console.log(`${String(Object.keys(templates).length)} workflows d’appel générés dans ${out}`);
