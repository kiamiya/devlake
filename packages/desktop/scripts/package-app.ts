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

/**
 * Signature facultative : un secret absent arrive vide depuis GitHub Actions, et
 * electron-builder prendrait `CSC_LINK=""` pour un certificat (chemin vide). Une variable vide
 * est donc retirée : sans certificat, l'installeur n'est simplement pas signé.
 */
const SIGNING_VARIABLES = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];
for (const name of SIGNING_VARIABLES)
  if (process.env[name]?.trim() === '') Reflect.deleteProperty(process.env, name);

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
