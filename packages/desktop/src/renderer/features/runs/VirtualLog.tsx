import { useMemo, useState } from 'react';

/** Hauteur d'une ligne de journal, en pixels (police monospace 12 px). */
export const LINE_HEIGHT = 18;
/** Lignes rendues en plus au-dessus et au-dessous de la zone visible. */
const OVERSCAN = 20;

/** Fenêtre de lignes à rendre pour une position de défilement. */
export function visibleWindow(
  scrollTop: number,
  viewportHeight: number,
  total: number,
): { start: number; end: number } {
  const first = Math.floor(scrollTop / LINE_HEIGHT);
  const count = Math.ceil(viewportHeight / LINE_HEIGHT);
  return {
    start: Math.max(0, first - OVERSCAN),
    end: Math.min(total, first + count + OVERSCAN),
  };
}

/**
 * Journal virtualisé : seules les lignes visibles (plus une marge) sont dans le DOM,
 * quelle que soit la longueur du journal. Recherche par filtre de lignes.
 */
export function VirtualLog({
  text,
  label,
  height = 480,
}: {
  text: string;
  label: string;
  height?: number;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [filter, setFilter] = useState('');
  const all = useMemo(() => text.split(/\r?\n/), [text]);
  const lines = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle === ''
      ? all.map((line, i) => ({ line, n: i + 1 }))
      : all.flatMap((line, i) => (line.toLowerCase().includes(needle) ? [{ line, n: i + 1 }] : []));
  }, [all, filter]);
  const { start, end } = visibleWindow(scrollTop, height, lines.length);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          aria-label={`Filtrer ${label}`}
          placeholder="Filtrer les lignes…"
          className="h-7 rounded-md border border-input bg-transparent px-2 text-xs"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setScrollTop(0);
          }}
        />
        <span>
          {lines.length === all.length
            ? `${String(all.length)} lignes`
            : `${String(lines.length)} / ${String(all.length)} lignes`}
        </span>
      </div>
      <div
        role="log"
        aria-label={label}
        tabIndex={0}
        className="overflow-auto rounded-md border border-border bg-muted/40 font-mono text-xs"
        style={{ height }}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
        }}
      >
        <div style={{ height: lines.length * LINE_HEIGHT, position: 'relative' }}>
          {lines.slice(start, end).map(({ line, n }, i) => (
            <div
              key={n}
              className="flex whitespace-pre"
              style={{
                position: 'absolute',
                top: (start + i) * LINE_HEIGHT,
                height: LINE_HEIGHT,
                lineHeight: `${String(LINE_HEIGHT)}px`,
              }}
            >
              <span className="w-14 shrink-0 select-none pr-2 text-right text-muted-foreground">
                {n}
              </span>
              <span>{line}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
