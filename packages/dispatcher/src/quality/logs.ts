/** Lignes qui signalent la cause d'un échec, toutes stacks confondues. */
const FAILURE =
  /(error|erreur|fail|failed|failure|échec|assert|expected|received|exception|traceback|panic|✗|×|✘|❌|##\[error\]|::error|exit code [1-9]|ELIFECYCLE|segmentation fault)/i;

/** Horodatage GitHub Actions en tête de ligne. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/;

/** Séquences de couleur ANSI. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function cleanLogLine(line: string): string {
  return line.replace(ANSI, '').replace(TIMESTAMP, '');
}

/**
 * Extraits pertinents d'un journal d'échec : chaque ligne d'erreur avec quelques lignes
 * de contexte, blocs fusionnés, dans la limite du budget ; la fin du journal en dernier
 * recours. Les extraits les plus récents sont gardés en priorité.
 */
export function extractRelevantLogs(
  logs: string,
  budget: number,
  context = { before: 3, after: 6 },
): string {
  const lines = logs.split(/\r?\n/).map(cleanLogLine);
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (!FAILURE.test(line)) return;
    for (
      let j = Math.max(0, i - context.before);
      j <= Math.min(lines.length - 1, i + context.after);
      j++
    )
      keep.add(j);
  });
  if (keep.size === 0) {
    const tail = lines.join('\n');
    return tail.length <= budget ? tail : `[… début coupé …]\n${tail.slice(-budget)}`;
  }
  // Blocs contigus, du plus récent au plus ancien, tant que le budget le permet.
  const indexes = [...keep].sort((a, b) => a - b);
  const blocks: number[][] = [];
  for (const i of indexes) {
    const last = blocks.at(-1);
    if (last && i === (last.at(-1) ?? -2) + 1) last.push(i);
    else blocks.push([i]);
  }
  const chosen: string[] = [];
  let used = 0;
  for (const block of blocks.reverse()) {
    const text = block.map((i) => lines[i]).join('\n');
    if (used + text.length > budget) {
      if (chosen.length === 0) chosen.push(text.slice(-budget));
      break;
    }
    chosen.unshift(text);
    used += text.length;
  }
  const skipped = blocks.length - chosen.length;
  return [
    ...(skipped > 0 ? [`[… ${String(skipped)} extrait(s) plus ancien(s) omis …]`] : []),
    chosen.join('\n[…]\n'),
  ].join('\n');
}
