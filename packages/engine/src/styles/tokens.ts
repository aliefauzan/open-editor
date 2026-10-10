// Style tokens as CSS custom properties `--tok-<group>-<name>` (styles spec "Tokens").
// Which style's tokens a scene gets (token scoping) is decided by compile (phase 03).
// Output is sorted, so the same tokens always give byte-identical CSS (compile snapshots).

import { VoxError } from '../errors.pending.ts';
import type { Tokens } from './schema.ts';

export type TokenGroup = 'color' | 'font' | 'texture' | 'motion';

export interface TokenVarsOptions {
  /** Maps a style-relative asset path to the URL used in the build. Default: the path as is. */
  assetUrl?: (token: 'texture-paper', path: string) => string;
}

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function tokenName(group: TokenGroup, key: string): string {
  return `--tok-${group}-${kebab(key)}`;
}

const cssString = (s: string): string => `"${s.replace(/["\\]/g, '\\$&')}"`;

function sortedGroup(group: TokenGroup, entries: [string, string][]): [string, string][] {
  const out = new Map<string, string>();
  for (const [key, value] of entries) {
    const name = tokenName(group, key);
    if (out.has(name)) {
      throw new VoxError(
        'STYLE_INVALID',
        `Two ${group} tokens map to ${name}`,
        'Rename one of the tokens (camelCase and kebab-case keys give the same CSS name)',
        { details: { reason: 'token-name', token: name } },
      );
    }
    out.set(name, value);
  }
  return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `[name, value]` pairs: colours, fonts (+ weight), texture, motion; sorted inside each group. */
export function tokenVars(tokens: Tokens, opts: TokenVarsOptions = {}): [string, string][] {
  const fonts: [string, string][] = [];
  for (const [role, font] of Object.entries(tokens.fonts)) {
    fonts.push([role, cssString(font.family)], [`${role}-weight`, String(font.weight)]);
  }
  const texture: [string, string][] = [];
  if (tokens.texture?.grain !== undefined) texture.push(['grain', String(tokens.texture.grain)]);
  if (tokens.texture?.paper !== undefined) {
    const url = opts.assetUrl?.('texture-paper', tokens.texture.paper) ?? tokens.texture.paper;
    texture.push(['paper', `url(${cssString(url)})`]);
  }
  const m = tokens.motion;
  return [
    ...sortedGroup('color', Object.entries(tokens.colors)),
    ...sortedGroup('font', fonts),
    ...sortedGroup('texture', texture),
    ...sortedGroup('motion', [
      ['easing', m.easing],
      ['entrance', m.entrance],
      ['frameHold', String(m.frameHold)],
      ['jitterPx', String(m.jitterPx)],
    ]),
  ];
}

/** One CSS rule declaring every token on `selector`. */
export function tokensCss(tokens: Tokens, selector: string, opts: TokenVarsOptions = {}): string {
  const body = tokenVars(tokens, opts)
    .map(([name, value]) => `  ${name}: ${value};\n`)
    .join('');
  return `${selector} {\n${body}}\n`;
}
