/** Gabarits `templates/caller/*.yml` du dépôt, intégrés au bundle du processus principal. */
const RAW = import.meta.glob<string>('../../../../../../templates/caller/*.yml', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const CALLER_TEMPLATES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(RAW).map(([path, content]) => [path.split('/').pop() ?? path, content]),
);
