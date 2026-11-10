import { gzipSync } from 'fflate';

const encoder = new TextEncoder();

function header(name: string, size: number): Uint8Array {
  const block = new Uint8Array(512);
  block.set(encoder.encode(name).subarray(0, 100), 0);
  const field = (value: string, offset: number) => {
    block.set(encoder.encode(value), offset);
  };
  field('0000644\0', 100);
  field('0000000\0', 108);
  field('0000000\0', 116);
  field(`${size.toString(8).padStart(11, '0')}\0`, 124);
  field('00000000000\0', 136);
  field('        ', 148);
  block[156] = '0'.charCodeAt(0);
  field('ustar\0', 257);
  field('00', 263);
  let sum = 0;
  for (const b of block) sum += b;
  field(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

/** Archive tar minimale (tests). */
export function tar(entries: Record<string, string | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    parts.push(header(name, data.length), data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** `.unitypackage` de test : chemin dans le projet → contenu (null : dossier, .meta seul). */
export function unityPackage(files: Record<string, string | Uint8Array | null>): Uint8Array {
  const entries: Record<string, string | Uint8Array> = {};
  let n = 0;
  for (const [path, content] of Object.entries(files)) {
    n += 1;
    const guid = n.toString(16).padStart(32, '0');
    entries[`${guid}/pathname`] = `${path}\n00`;
    if (content !== null) entries[`${guid}/asset`] = content;
    entries[`${guid}/asset.meta`] = `fileFormatVersion: 2\nguid: ${guid}\n`;
  }
  return gzipSync(tar(entries));
}
