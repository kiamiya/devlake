/**
 * Règles de dépendances entre paquets (voir CLAUDE.md, « Règles de dépendances »).
 * @type {import('dependency-cruiser').IConfiguration}
 */
const notAllowed = (from, allowed) => ({
  name: `${from}-dependances`,
  comment: `${from} ne peut dépendre que de : ${allowed.length ? allowed.join(', ') : 'rien'}.`,
  severity: 'error',
  from: { path: `^packages/${from}/` },
  to: { path: `^packages/(?!(${[from, ...allowed].join('|')})/)` },
});

module.exports = {
  forbidden: [
    notAllowed('shared', []),
    notAllowed('github', ['shared']),
    notAllowed('planner', ['shared', 'github']),
    notAllowed('dispatcher', ['shared', 'github']),
    notAllowed('aura-bridge', ['shared']),
    notAllowed('desktop', ['shared', 'github', 'aura-bridge']),
    {
      name: 'electron-reserve-a-desktop',
      comment: 'Seul le paquet desktop importe Electron.',
      severity: 'error',
      from: { pathNot: '^packages/desktop/' },
      to: { path: '(^|/)electron($|/)' },
    },
    {
      name: 'renderer-sans-main',
      comment: 'Le renderer du cockpit n’importe jamais le processus principal.',
      severity: 'error',
      from: { path: '^packages/desktop/src/renderer/' },
      to: { path: '^packages/desktop/src/main/' },
    },
    {
      name: 'pas-de-cycle',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'pas-d-import-introuvable',
      comment: 'Un import qui ne se résout pas masquerait une dépendance interdite.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
