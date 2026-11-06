# Publication

Une version d'AgentLake = un tag `vX.Y.Z` sur `kiamiya/devlake`. Il publie à la fois les installeurs du cockpit et les workflows réutilisables appelés par les projets.

## Publier une version

1. Vérifier que `main` est vert (CI, E2E Windows et macOS).
2. Taguer et pousser :

   ```bash
   git tag v1.2.0
   git push origin v1.2.0
   ```

3. `.github/workflows/release.yml` :
   - construit les installeurs (NSIS Windows x64, dmg macOS arm64 et x64) à la version du tag ;
   - **installe** chacun sur un runner propre (NSIS silencieux, dmg monté) et lance le **test de fumée** de l'application installée (`packages/desktop/e2e-packaged/`) ;
   - crée la release avec les installeurs et des notes générées ;
   - déplace le **tag majeur** (`v1`) sur ce commit.

Une PR qui touche le packaging (`electron-builder.yml`, `package-app.ts`, test de fumée, `release.yml`) lance les installeurs et le test de fumée sans rien publier.

En local : `node packages/desktop/scripts/package-app.ts --win` (ou `--mac`, `--dir` pour un dossier décompressé, `--version X.Y.Z`), puis `AGENTLAKE_APP_PATH=<exécutable> npx playwright test -c playwright.packaged.config.ts` dans `packages/desktop`.

## Versions des workflows et mise à jour des projets

Les workflows d'appel des projets (`.github/workflows/agentlake-*.yml`) appellent `kiamiya/devlake/.github/workflows/*.yml@<version>`, la version étant le réglage **Version des workflows devlake** du cockpit au moment du bootstrap (`v1` par défaut).

- **Correctifs et évolutions compatibles** (`v1.2.0` → `v1.3.0`) : rien à faire. Le tag `v1` suit la dernière version `v1.x.y` ; les projets la prennent au run suivant.
- **Nouvelle majeure** (`v2.0.0`, changement incompatible des entrées ou des secrets) :
  1. lire les notes de version ;
  2. cockpit : **Réglages** → **Version des workflows devlake** = `v2` ;
  3. pour chaque projet : **Relancer le bootstrap**, qui réécrit les workflows d'appel épinglés sur `v2` (rien d'autre ne change si tout est en place).
- **Épingler une version exacte** pour un projet (gel, diagnostic) : régler la version sur `vX.Y.Z` avant de relancer son bootstrap, puis revenir au tag majeur.

## Signature (facultative)

Sans certificat, les installeurs ne sont pas signés (SmartScreen et Gatekeeper avertissent, voir [installation](../utilisateur/installation.md)). Pour signer, créer ces secrets sur `kiamiya/devlake` ; electron-builder les utilise s'ils sont présents :

| Secret                                         | Rôle                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`         | Certificat de signature de code Windows (.pfx en base64) et son mot de passe |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`         | Certificat « Developer ID Application » (.p12 en base64) et son mot de passe |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarisation Apple                                       |

Hors périmètre : mise à jour automatique du cockpit (installer la nouvelle version par-dessus).
