// Claude Code skill (plan 14c; agent spec "Claude Code skill"): `.claude/skills/vox-studio/SKILL.md`
// may only call things that exist: `vox` commands and flags in `vox --help --json`, engine op names,
// style templates, and the shared workflow files.
import { OP_NAMES } from '@vox/engine';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadWorkflow } from '../src/workflows/load.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const skill = readFileSync(`${ROOT}.claude/skills/vox-studio/SKILL.md`, 'utf8');
// `vox --help` prints the usage text and exits 2 (usage), so read both streams.
const r = spawnSync(process.execPath, [`${ROOT}packages/cli/bin/vox.js`, '--help', '--json'], {
  encoding: 'utf8',
});
const help = r.stdout + r.stderr;

/** Lines of the fenced bash blocks that start with `vox `. */
const commandLines = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)]
  .flatMap((m) => (m[1] as string).split('\n'))
  .filter((l) => l.startsWith('vox '));

describe('Claude Code skill', () => {
  test('frontmatter names the skill and says when to use it', () => {
    const m = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill);
    expect(m?.[1]).toBe('vox-studio');
    expect(m?.[2]?.length).toBeGreaterThan(40);
  });

  test('walks the six clipper checkpoints in order', () => {
    const order = loadWorkflow('clipper').checkpoints;
    const at = order.map((c) => skill.indexOf(`(checkpoint \`${c}\`)`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test('every `vox <command>` in a bash block is in `vox --help --json`', () => {
    expect(commandLines.length).toBeGreaterThan(10);
    for (const line of commandLines) {
      const words = line.split(/\s+/);
      const prefix = ['assets', 'config', 'style'].includes(words[1] ?? '')
        ? `vox ${words[1]} ${words[2]}`
        : `vox ${words[1]}`;
      expect(help, line).toContain(`  ${prefix}`);
    }
  });

  test('every --flag on those lines is in the help text', () => {
    for (const line of commandLines)
      for (const f of line.match(/--[a-z][a-z-]*/g) ?? [])
        expect(help, `${f} in: ${line}`).toContain(f);
  });

  test('the shared commands the skill leans on are all there', () => {
    for (const c of [
      'quick',
      'op',
      'frames',
      'audio-qa',
      'render',
      'assets search',
      'assets fetch',
      'assets cutout',
    ])
      expect(
        commandLines.some((l) => l.startsWith(`vox ${c} `)),
        c,
      ).toBe(true);
  });

  test('every op name it uses is an engine op', () => {
    const names = new Set<string>(OP_NAMES);
    const used = [
      ...skill.matchAll(/vox op <project> ([A-Za-z]+) /g),
      ...skill.matchAll(/"op":"([A-Za-z]+)"/g),
      ...skill.matchAll(/`(addScene|setTransition|updateScene|moveItem|trimItem)`/g),
    ].map((m) => m[1] as string);
    expect(used.length).toBeGreaterThan(5);
    for (const op of used) expect(names.has(op) || op === 'batch', op).toBe(true);
  });

  test('every `vox/...` template, transition and caption preset exists in the style', () => {
    const dir = `${ROOT}styles/vox/`;
    const templates = new Set(readdirSync(`${dir}templates`).map((t) => `vox/${t}`));
    const style = JSON.parse(readFileSync(`${dir}style.json`, 'utf8')) as {
      captions: { presets: string[] };
    };
    const known = new Set([...templates, ...style.captions.presets]);
    const used = [...skill.matchAll(/(?<![/\w])vox\/[a-z][a-z-]*/g)].map((m) => m[0]);
    expect(used.length).toBeGreaterThan(3);
    for (const id of used) expect(known.has(id), id).toBe(true);
  });

  test('the files it tells Claude to read exist, and the workflows it names load', () => {
    for (const p of [
      'packages/agent/workflows/clipper.md',
      'packages/agent/workflows/stylize.md',
      'styles/vox/guide.md',
    ])
      expect(skill, p).toContain(p);
    for (const p of [
      'packages/agent/workflows/clipper.md',
      'packages/agent/workflows/stylize.md',
      'styles/vox/guide.md',
    ])
      expect(existsSync(`${ROOT}${p}`), p).toBe(true);
    expect(loadWorkflow('clipper').name).toBe('clipper');
    expect(loadWorkflow('stylize').name).toBe('stylize');
  });

  test('no secret-looking text', () => {
    expect(skill).not.toMatch(/sk-[A-Za-z0-9]{10}|Bearer |api[_-]?key\s*=/i);
  });
});
