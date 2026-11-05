import type { PullRequestFile } from 'github';

/**
 * Fichiers de test, toutes stacks des profils qualité : JS/TS, Python, Go, Rust, C#/Unity,
 * C++/Unreal, mobile. Les instantanés de test comptent comme des tests.
 */
const TEST_PATTERNS = [
  /(^|\/)(__tests__|__snapshots__|tests?|spec|specs|e2e|integration-tests?)\//i,
  /\.(test|spec|e2e|integration|live)\.[cm]?[jt]sx?$/,
  /\.snap$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go)$/,
  /(^|\/)Tests?\/.+\.cs$/,
  /(Tests?|Spec)\.(cs|cpp|h)$/,
  /(^|\/)(androidTest|testDebug|test)\//,
  /Tests?\.(kt|java|swift)$/,
  /(^|\/)\.maestro\//,
];

/** Extensions de code applicatif. */
const CODE_EXTENSIONS =
  /\.(c|cc|cpp|cs|cxx|dart|go|h|hpp|java|js|jsx|kt|mjs|cjs|php|py|rb|rs|sql|swift|ts|tsx|vue|svelte|gd)$/;

/** Fichiers de code qui n'appellent pas de test (configuration, déclarations, outillage). */
const NOT_APPLICATION_CODE = [
  /(^|\/)[^/]*\.config\.[cm]?[jt]s$/,
  /\.d\.ts$/,
  /(^|\/)(scripts|\.github|\.agentlake|migrations|supabase\/migrations)\//,
];

export function isTestFile(path: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(path));
}

export function isApplicationCode(path: string): boolean {
  return (
    CODE_EXTENSIONS.test(path) &&
    !isTestFile(path) &&
    !NOT_APPLICATION_CODE.some((p) => p.test(path))
  );
}

export interface TestChange {
  file: string;
  kind: 'modifié' | 'supprimé' | 'renommé';
}

export interface TestAnalysis {
  /** Tests existants modifiés (lignes supprimées), supprimés ou renommés. */
  alteredTests: TestChange[];
  /** Tests ajoutés ou complétés (ajouts seuls). */
  addedTests: string[];
  /** Code applicatif touché. */
  applicationCode: string[];
}

/**
 * Lit les fichiers d'une PR. Un fichier de test existant dont seules des lignes sont
 * ajoutées est complété, pas modifié ; toute ligne supprimée en fait une modification.
 */
export function analyzeTestChanges(files: readonly PullRequestFile[]): TestAnalysis {
  const alteredTests: TestChange[] = [];
  const addedTests: string[] = [];
  const applicationCode: string[] = [];
  for (const f of files) {
    const wasTest = f.previousFilename !== undefined && isTestFile(f.previousFilename);
    if (isTestFile(f.filename) || wasTest) {
      if (f.status === 'removed') alteredTests.push({ file: f.filename, kind: 'supprimé' });
      else if (f.status === 'renamed' && wasTest)
        alteredTests.push({ file: `${f.previousFilename ?? ''} → ${f.filename}`, kind: 'renommé' });
      else if (f.status === 'added' || f.status === 'copied') addedTests.push(f.filename);
      else if (f.deletions > 0) alteredTests.push({ file: f.filename, kind: 'modifié' });
      else if (f.additions > 0) addedTests.push(f.filename);
    } else if (isApplicationCode(f.filename) && f.status !== 'removed') {
      applicationCode.push(f.filename);
    }
  }
  return { alteredTests, addedTests, applicationCode };
}
