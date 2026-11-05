const KNOWN_PREFIXES = [
  'github_pat_',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'sk-ant-oat01-',
  'sk-ant-',
];
const DOTS = '••••••••';

/** Affichage d'un jeton : préfixe connu et 4 derniers caractères au plus. */
export function maskToken(token: string): string {
  if (token.length <= 12) return DOTS;
  const prefix = KNOWN_PREFIXES.find((p) => token.startsWith(p)) ?? '';
  return `${prefix}${DOTS}${token.slice(-4)}`;
}
