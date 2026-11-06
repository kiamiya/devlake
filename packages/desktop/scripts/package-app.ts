/**
 * Installeurs du cockpit (T23) : compilation electron-vite, puis electron-builder avec la
 * version exacte d'Electron installée (electron-builder refuse une plage de versions).
 *
 *   node scripts/package-app.ts --win            # NSIS
 *   node scripts/package-app.ts --mac            # dmg
 *   node scripts/package-app.ts --win --dir      # dossier décompressé (test de fumée)
 *   node scripts/package-app.ts --win --version 1.2.3
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = (require('electron/package.json') as { version: string }).version;

const args = process.argv.slice(2);
const versionAt = args.indexOf('--version');
const version = versionAt >= 0 ? args[versionAt + 1] : undefined;
if (versionAt >= 0) args.splice(versionAt, 2);
if (version !== undefined && !/^\d+\.\d+\.\d+$/.test(version))
  throw new Error(`Version attendue au format X.Y.Z : ${version}.`);

/** Commande lancée par le shell (npx est un script .cmd sous Windows) ; arguments sans espace. */
function run(command: string, commandArgs: string[]): void {
  for (const arg of commandArgs)
    if (!/^[\w.=:-]+$/.test(arg)) throw new Error(`Argument refusé : ${arg}.`);
  execSync([command, ...commandArgs].join(' '), { stdio: 'inherit' });
}

run('npx', ['electron-vite', 'build']);
run('npx', [
  'electron-builder',
  `-c.electronVersion=${electron}`,
  ...(version !== undefined ? [`-c.extraMetadata.version=${version}`] : []),
  '--publish',
  'never',
  ...args,
]);
