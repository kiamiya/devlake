import { useState, type DragEvent } from 'react';
import { cn } from '../../lib/utils.js';

/**
 * Zone de dépôt multi-fichiers. Les fichiers sont confiés au preload,
 * seul à pouvoir lire leur chemin.
 */
export function DropZone({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled: boolean;
}) {
  const [over, setOver] = useState(false);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0 && !disabled) onFiles(files);
  };

  return (
    <div
      data-testid="drop-zone"
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={onDrop}
      className={cn(
        'flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border p-6 text-sm text-muted-foreground',
        over && 'border-primary bg-muted',
      )}
    >
      <p>Déposer ici des fichiers (docx, html, md, txt, pdf, images)</p>
      <label className="cursor-pointer underline">
        ou parcourir
        <input
          type="file"
          multiple
          aria-label="Ajouter des fichiers"
          className="sr-only"
          disabled={disabled}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length > 0) onFiles(files);
          }}
        />
      </label>
    </div>
  );
}
