import { ProjectConfigSchema, type ProjectConfig, type ProjectType } from 'shared';
import { stringify } from 'yaml';

/** Dépôt qui héberge les workflows réutilisables. */
export const DEVLAKE_REPOSITORY = 'kiamiya/devlake';

export { PROJECT_CONFIG_PATH } from '../../db/rebuild.js';

export interface CallerVariables {
  repository: string;
  ref: string;
}

/** Remplace les marqueurs des gabarits d'appel ; chemin `.github/workflows/<fichier>` → contenu. */
export function renderCallers(
  templates: Readonly<Record<string, string>>,
  variables: CallerVariables,
): Map<string, string> {
  const files = new Map<string, string>();
  for (const [name, template] of Object.entries(templates).sort(([a], [b]) => a.localeCompare(b))) {
    const content = template
      .replaceAll('__DEVLAKE_REPOSITORY__', variables.repository)
      .replaceAll('__DEVLAKE_REF__', variables.ref);
    const unresolved = /__[A-Z_]+__/.exec(content);
    if (unresolved) throw new Error(`Marqueur non remplacé dans ${name} : ${unresolved[0]}.`);
    files.set(`.github/workflows/${name}`, content);
  }
  return files;
}

const COMMON_LFS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'psd',
  'pdf',
  'zip',
  'mp3',
  'wav',
  'ogg',
  'mp4',
  'mov',
  'ttf',
  'otf',
];
const GAME_LFS = ['fbx', 'obj', 'blend', 'tga', 'exr', 'hdr', 'tif', 'tiff'];
const UNREAL_LFS = ['uasset', 'umap'];
const UNITY_LFS = ['unitypackage', 'cubemap', 'aif'];

/** `.gitattributes` : binaires en Git LFS ; fins de ligne normalisées. */
export function gitattributes(type: ProjectType): string {
  const extensions = [
    ...COMMON_LFS,
    ...(type === 'unity' || type === 'unreal' ? GAME_LFS : []),
    ...(type === 'unity' ? UNITY_LFS : []),
    ...(type === 'unreal' ? UNREAL_LFS : []),
  ];
  const lines = [
    '# Généré par AgentLake : binaires dans Git LFS.',
    '* text=auto',
    '# Images du contexte (versées par le cockpit via l’API LFS).',
    '.agentlake/context/assets/** filter=lfs diff=lfs merge=lfs -text',
    ...extensions.map((ext) => `*.${ext} filter=lfs diff=lfs merge=lfs -text`),
  ];
  if (type === 'unity') {
    lines.push('# Unity : scènes et prefabs sérialisés en texte, fusion YAML.');
    lines.push(
      '*.unity merge=unityyamlmerge eol=lf',
      '*.prefab merge=unityyamlmerge eol=lf',
      '*.meta eol=lf',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** `.agentlake/project.yml`, validé par le schéma partagé. */
export function projectYaml(config: ProjectConfig): string {
  const valid = ProjectConfigSchema.parse(config);
  return `# Configuration AgentLake du projet.\n${stringify(valid)}`;
}
