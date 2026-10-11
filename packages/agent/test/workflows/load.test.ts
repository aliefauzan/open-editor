// Workflow files (agent spec "Workflows"; plan D-15): the frontmatter the loop reads.
import { describe, expect, test } from 'vitest';
import { CLIPPER_CORE_TOOLS, buildRegistry } from '../../src/tools/registry.ts';
import { loadWorkflow, parseWorkflow, WORKFLOW_NAMES } from '../../src/workflows/load.ts';

const registry = buildRegistry({ imageProviders: { list: () => [], register: () => undefined } });

describe('workflow files', () => {
  test('clipper: the 12 core tools, roles and the six checkpoints in order', () => {
    const w = loadWorkflow('clipper');
    expect(w.name).toBe('clipper');
    expect(w.allowedTools).toEqual([...CLIPPER_CORE_TOOLS]);
    expect(w.roles).toEqual(['editor', 'fast', 'vision']);
    expect(w.checkpoints).toEqual(['ranges', 'tighten', 'storyboard', 'fill', 'review', 'sound']);
    expect(w.prompt).toContain('# Clipper');
  });

  test('stylize: the same tools without ranges and tighten', () => {
    const w = loadWorkflow('stylize');
    expect(w.allowedTools).toEqual(loadWorkflow('clipper').allowedTools);
    expect(w.checkpoints).toEqual(['storyboard', 'fill', 'review', 'sound']);
  });

  test('edit: its own list, no checkpoints; every listed tool exists', () => {
    const w = loadWorkflow('edit');
    expect(w.checkpoints).toEqual([]);
    expect(w.allowedTools).toContain('trim_item');
    for (const n of WORKFLOW_NAMES) {
      for (const t of loadWorkflow(n).allowedTools) expect(registry.get(t), t).toBeDefined();
    }
  });

  test('bad frontmatter fails with a clear message', () => {
    expect(() => parseWorkflow('no frontmatter')).toThrow(/frontmatter/);
    expect(() =>
      parseWorkflow('---\nname: x\nallowedTools: [a]\nroles: [editor]\ncheckpoints: [nope]\n---\n'),
    ).toThrow(/checkpoints/);
    expect(() =>
      parseWorkflow('---\nname: x\nallowedTools: [a, a]\nroles: [editor]\ncheckpoints: []\n---\n'),
    ).toThrow(/allowedTools/);
    expect(() => parseWorkflow('---\nname: x\nroles: [editor]\ncheckpoints: []\n---\n')).toThrow(
      /allowedTools/,
    );
  });

  test('an unknown workflow name is refused', () => {
    expect(() => loadWorkflow('../evil' as never)).toThrow(/workflow/);
  });

  test('only the packaged workflow files load (no folder argument)', () => {
    expect(loadWorkflow.length).toBe(1);
  });
});

describe('frontmatter list forms', () => {
  test('a list may open on the next line and end with a trailing comma (prettier form)', () => {
    const w = parseWorkflow(
      '---\nname: x\nallowedTools:\n  [\n    get_sequence,\n    trim_item,\n  ]\nroles: [editor]\ncheckpoints: []\n---\nbody\n',
    );
    expect(w.allowedTools).toEqual(['get_sequence', 'trim_item']);
    expect(w.prompt).toBe('body');
  });
});

describe('packaged workflows folder (phase 13)', () => {
  test('setWorkflowsDir points the loader at the app Resources copy; undefined restores the repo folder', async () => {
    const { cpSync, mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { setWorkflowsDir, workflowsDir } = await import('../../src/workflows/load.ts');
    const repoDir = fileURLToPath(new URL('../../workflows/', import.meta.url));
    const dir = join(mkdtempSync(join(tmpdir(), 'vox-wf-')), 'workflows');
    cpSync(repoDir, dir, { recursive: true });
    const edited = loadWorkflow('edit');
    writeFileSync(
      join(dir, 'edit.md'),
      `---\nname: edit\nallowedTools: [get_sequence]\nroles: [editor]\ncheckpoints: []\n---\npackaged copy\n`,
    );
    try {
      setWorkflowsDir(dir);
      expect(workflowsDir()).toBe(dir);
      expect(loadWorkflow('edit').prompt).toBe('packaged copy');
      expect(loadWorkflow('clipper').name).toBe('clipper');
    } finally {
      setWorkflowsDir(undefined);
    }
    expect(loadWorkflow('edit')).toEqual(edited);
  });
});
