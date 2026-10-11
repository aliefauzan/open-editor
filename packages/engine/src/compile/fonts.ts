// `@font-face` rules for the fonts a build uses (engine spec "Compile": fonts are always copied into
// `build/fonts/`). The weight range comes from the font file itself, so a variable font serves every
// weight and a static file only its own; sibling files of the same family (`IBMPlexMono-Bold.ttf`
// next to `IBMPlexMono-Regular.ttf`) get their own face, so a template's bold has a real bold.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

export interface FontFace {
  family: string;
  /** Absolute source file. */
  file: string;
  /** Build-relative path (`fonts/<styleId>/<file>`). */
  url: string;
  weight: [number, number];
  italic: boolean;
}

const FONT_EXT = /\.(?:ttf|otf|woff2?)$/i;

/** `[min, max]` weight of an OpenType/TrueType file: the `fvar` wght axis, else OS/2 usWeightClass. */
export function fontWeightRange(file: string, fallback: number): [number, number] {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return [fallback, fallback];
  }
  if (buf.length < 12) return [fallback, fallback];
  const tables = new Map<string, number>();
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n && 12 + i * 16 + 16 <= buf.length; i++) {
    const rec = 12 + i * 16;
    tables.set(buf.toString('latin1', rec, rec + 4), buf.readUInt32BE(rec + 8));
  }
  const fvar = tables.get('fvar');
  if (fvar !== undefined && fvar + 16 <= buf.length) {
    const axesOffset = buf.readUInt16BE(fvar + 4);
    const axisCount = buf.readUInt16BE(fvar + 8);
    const axisSize = buf.readUInt16BE(fvar + 10);
    for (let i = 0; i < axisCount; i++) {
      const a = fvar + axesOffset + i * axisSize;
      if (a + 20 > buf.length) break;
      if (buf.toString('latin1', a, a + 4) !== 'wght') continue;
      const min = buf.readInt32BE(a + 4) / 65536;
      const max = buf.readInt32BE(a + 12) / 65536;
      return [Math.round(min), Math.round(max)];
    }
  }
  const os2 = tables.get('OS/2');
  if (os2 !== undefined && os2 + 6 <= buf.length) {
    const w = buf.readUInt16BE(os2 + 4);
    if (w >= 1 && w <= 1000) return [w, w];
  }
  return [fallback, fallback];
}

const isItalic = (name: string) => /italic/i.test(name);

/**
 * The faces of one token font: the file itself, plus files in the same folder that share its
 * family prefix (the part before the first `-`).
 */
export function facesFor(
  family: string,
  file: string,
  weight: number,
  styleId: string,
): FontFace[] {
  const dir = dirname(file);
  const own = basename(file);
  const prefix = own.split('-')[0]!;
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => FONT_EXT.test(n) && (n === own || n.startsWith(`${prefix}-`)))
      .sort();
  } catch {
    names = [own];
  }
  if (!names.includes(own)) names.unshift(own);
  return names.map((name) => {
    const abs = join(dir, name);
    return {
      family,
      file: abs,
      url: `fonts/${styleId}/${name}`,
      weight: fontWeightRange(abs, weight),
      italic: isItalic(name),
    };
  });
}

const FORMAT: Record<string, string> = {
  '.ttf': 'truetype',
  '.otf': 'opentype',
  '.woff': 'woff',
  '.woff2': 'woff2',
};

export function fontFaceCss(faces: readonly FontFace[]): string {
  return faces
    .map((f) => {
      const w = f.weight[0] === f.weight[1] ? `${f.weight[0]}` : `${f.weight[0]} ${f.weight[1]}`;
      const fmt = FORMAT[extname(f.file).toLowerCase()] ?? 'truetype';
      return `@font-face { font-family: "${f.family}"; src: url("${f.url}") format("${fmt}"); font-weight: ${w}; font-style: ${f.italic ? 'italic' : 'normal'}; font-display: block; }`;
    })
    .join('\n');
}
