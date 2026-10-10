// Style tokens as CSS custom properties `--tok-<group>-<name>` (styles spec "Tokens").
// Which style's tokens a scene gets (token scoping) is decided by compile (phase 03).
// Output is sorted, so the same tokens always give byte-identical CSS (compile snapshots).

import { VoxError } from '../errors.ts';
import { kebabKey, TokensSchema, type Tokens } from './schema.ts';

export type TokenGroup = 'color' | 'font' | 'texture' | 'motion';

export interface TokenVarsOptions {
  /** Maps a style-relative asset path to the URL used in the build. Default: the path as is. */
  assetUrl?: (token: 'texture-paper', path: string) => string;
}

export function tokenName(group: TokenGroup, key: string): string {
  return `--tok-${group}-${kebabKey(key)}`;
}

// CSS string: quote and backslash escaped; `<`, `>` and control characters as hex escapes, so a
// mapped asset URL can never close the string or the surrounding `<style>` element.
const cssString = (s: string): string =>
  `"${s.replace(/["\\<>]|[^\x20-\x7e]/g, (c) =>
    c === '"' || c === '\\' ? `\\${c}` : `\\${c.codePointAt(0)!.toString(16)} `,
  )}"`;

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
export function tokenVars(input: Tokens, opts: TokenVarsOptions = {}): [string, string][] {
  // Values are re-checked here too: the CSS goes into builds, whoever built the object.
  const parsed = TokensSchema.safeParse(input);
  if (!parsed.success) {
    throw new VoxError(
      'STYLE_INVALID',
      `Tokens do not match the style format: ${parsed.error.issues[0]?.message ?? ''}`,
      'Fix the style tokens (styles spec "Tokens")',
      { details: { reason: 'schema', issues: parsed.error.issues.map((i) => i.message) } },
    );
  }
  const tokens = parsed.data;
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
