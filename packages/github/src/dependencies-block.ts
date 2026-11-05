/**
 * Repli quand le compte n'a pas les relations de dépendance natives :
 * les numéros d'issues bloquantes vivent dans un bloc caché en fin de corps.
 */
const BLOCK = /\n*<!-- agentlake:blocked-by ([0-9,]*) -->\s*$/;

export function readBlockedBy(body: string): number[] {
  const list = BLOCK.exec(body)?.[1];
  if (list === undefined || list === '') return [];
  return list.split(',').map(Number);
}

export function writeBlockedBy(body: string, blockedBy: readonly number[]): string {
  const base = body.replace(BLOCK, '');
  if (blockedBy.length === 0) return base;
  const unique = [...new Set(blockedBy)].sort((a, b) => a - b);
  return `${base}\n\n<!-- agentlake:blocked-by ${unique.join(',')} -->\n`;
}
