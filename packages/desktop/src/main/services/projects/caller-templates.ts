/** Gabarits `templates/caller/*.yml` du dépôt, intégrés au bundle du processus principal. */
const RAW = import.meta.glob<string>('../../../../../../templates/caller/*.yml', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const CALLER_TEMPLATES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(RAW).map(([path, content]) => [path.split('/').pop() ?? path, content]),
);

/** Profils d'agents par défaut `templates/profiles/*.yml`, copiés au bootstrap. */
const RAW_PROFILES = import.meta.glob<string>('../../../../../../templates/profiles/*.yml', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const PROFILE_TEMPLATES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(RAW_PROFILES).map(([path, content]) => [path.split('/').pop() ?? path, content]),
);
