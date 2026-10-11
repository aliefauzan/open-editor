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
});
