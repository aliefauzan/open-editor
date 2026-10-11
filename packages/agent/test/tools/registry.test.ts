// Steps 3, 4, 14, 18 (S22, S24, S32, S35; D-15): tool generation, the tool surface, call_tool and
// describe_tool rules, update_todos and undo_my_last_edit, on a real engine with a fixture project.
import { OP_NAMES } from '@vox/engine';
import { describe, expect, test } from 'vitest';
import { toolNameOf } from '../../src/tools/ops.ts';
import {
  ALWAYS_PRESENT,
  CLIPPER_CORE_TOOLS,
  aiToolSet,
  buildRegistry,
  invokeTool,
  surfaceNames,
} from '../../src/tools/registry.ts';
import { fixtureProject, toolContext } from '../helpers/project.ts';

const noImages = { imageProviders: { list: () => [], register: () => undefined } };

describe('tool generation (step 3, S22, S32)', () => {
  const r = buildRegistry(noImages);

  test('one write tool per engine op: the snapshot of tool names = op names', () => {
    const writeNames = r
      .names()
      .filter((n) => r.get(n)?.kind === 'write' && n !== 'undo_my_last_edit');
    expect(writeNames.sort()).toEqual(OP_NAMES.map(toolNameOf).sort());
    expect(writeNames).toContain('remove_pauses');
    expect(writeNames).toContain('remove_words');
    expect(writeNames).toContain('batch');
  });

  test('the full tool list (snapshot)', () => {
    expect(r.names()).toMatchInlineSnapshot(`
      [
        "add_media",
        "add_scene",
        "add_sequence",
        "add_track",
        "batch",
        "call_tool",
        "check_audio",
        "cutout",
        "describe_tool",
        "duplicate_sequence",
        "facetrack",
        "fetch_image",
        "get_project_summary",
        "get_sequence",
        "get_style",
        "get_template",
        "get_transcript",
        "ingest",
        "link",
        "list_styles",
        "move_item",
        "paste_items",
        "place_clip",
        "remove_item",
        "remove_media",
        "remove_pauses",
        "remove_sequence",
        "remove_track",
        "remove_words",
        "reorder_tracks",
        "replace_media",
        "restore_snapshot",
        "ripple_delete",
        "search_images",
        "search_places",
        "search_transcript",
        "set_captions",
        "set_clip_speed",
        "set_transition",
        "shots",
        "split_item",
        "transcribe",
        "trim_item",
        "undo_my_last_edit",
        "unlink",
        "update_clip",
        "update_media",
        "update_scene",
        "update_sequence",
        "update_todos",
        "update_track",
        "view_frames",
        "view_media",
      ]
    `);
  });

  test('no shell, file, HTTP, render or export tool', () => {
    for (const n of r.names()) {
      expect(n).not.toMatch(
        /shell|exec|bash|command|file|write_|http|fetch_url|request|render|export|download|upload|save/,
      );
    }
  });

  test('no argument is named or shaped like an output path', () => {
    const bad =
      /^(out|output|outDir|outPath|outputPath|path|dest|destination|target|targetId|file|filename|dir|folder)$/i;
    const walk = (schema: unknown, at: string): string[] => {
      if (schema === null || typeof schema !== 'object') return [];
      const o = schema as Record<string, unknown>;
      const found: string[] = [];
      const props = o['properties'] as Record<string, unknown> | undefined;
      for (const [k, v] of Object.entries(props ?? {})) {
        if (bad.test(k) || /(^|[a-z])(Path|Dir|File)$/.test(k)) found.push(`${at}.${k}`);
        found.push(...walk(v, `${at}.${k}`));
      }
      for (const [k, v] of Object.entries(o)) if (k !== 'properties') found.push(...walk(v, at));
      return found;
    };
    const offenders = r.names().flatMap((n) => walk(r.modelSchema(n), n));
    // add_media takes a media item whose path is project-relative and already on disk (input, not output)
    expect(
      offenders.filter(
        (o) => !o.startsWith('add_media.media.') && !o.startsWith('update_media.patch.'),
      ),
    ).toEqual([]);
  });

  test('model schemas take short ids: no engine id pattern on id fields', () => {
    const s = JSON.stringify(r.modelSchema('move_item'));
    expect(s).not.toContain('^it_');
    expect(s).not.toContain('^seq_');
  });
});

describe('tool surface (step 14, S35)', () => {
  const r = buildRegistry(noImages);

  test('a workflow sends exactly its allowedTools plus the always-present tools', () => {
    const names = surfaceNames(r, CLIPPER_CORE_TOOLS, { mode: 'tools' });
    expect(names.sort()).toEqual([...CLIPPER_CORE_TOOLS, ...ALWAYS_PRESENT].sort());
    expect(Object.keys(aiToolSet(r, names)).sort()).toEqual(names.sort());
    expect(names).toContain('get_sequence');
  });

  test('plan mode has no update_todos; a question turn keeps only read and meta read tools', () => {
    expect(surfaceNames(r, ['get_transcript'], { mode: 'plan' })).not.toContain('update_todos');
    const q = surfaceNames(r, ['get_transcript', 'remove_item'], { mode: 'tools', question: true });
    expect(q).toEqual(['get_transcript', 'describe_tool', 'call_tool', 'get_sequence']);
  });

  test('call_tool reaches a tool outside the list, with actor agent and the runId', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f);
    const v = await invokeTool(ctx, r, 'get_sequence', { sequenceId: f.sequenceId });
    const c1 = (v.result as { items: { id: string; track: string }[] }).items.find(
      (i) => i.track === 'V1',
    )!.id;
    const out = await invokeTool(ctx, r, 'call_tool', {
      name: 'update_clip',
      args: { sequenceId: 's1', itemId: c1, volume: 0.5 },
    });
    expect((out.result as { results: { status: string }[] }).results[0]?.status).toBe('succeeded');
    const last = (await f.engine.history(f.projectId)).at(-1)!;
    expect(last).toMatchObject({ actor: 'agent', runId: 'run_test', op: 'updateClip' });
  });

  test('call_tool validates with the same zod schema', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f);
    await invokeTool(ctx, r, 'get_sequence', { sequenceId: f.sequenceId });
    await expect(
      invokeTool(ctx, r, 'call_tool', {
        name: 'move_item',
        args: { sequenceId: 's1', itemId: 'c1', startMs: -5 },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  test('call_tool with an unknown name fails with the list of tool names', async () => {
    const f = await fixtureProject();
    const err = (await invokeTool(toolContext(f), r, 'call_tool', {
      name: 'run_shell',
      args: {},
    }).catch((e: unknown) => e)) as { code: string; hint: string };
    expect(err.code).toBe('TOOL_UNKNOWN');
    expect(err.hint).toContain('get_transcript');
  });

  test('a question turn: call_tool refuses non-read tools, allows read tools', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f, { question: true });
    await invokeTool(ctx, r, 'call_tool', {
      name: 'get_sequence',
      args: { sequenceId: f.sequenceId },
    });
    await expect(
      invokeTool(ctx, r, 'call_tool', {
        name: 'remove_item',
        args: { sequenceId: 's1', itemId: 'c1' },
      }),
    ).rejects.toMatchObject({ code: 'TOOL_REFUSED' });
    await expect(
      invokeTool(ctx, r, 'remove_item', { sequenceId: 's1', itemId: 'c1' }),
    ).rejects.toMatchObject({
      code: 'TOOL_REFUSED',
    });
    expect((await f.engine.history(f.projectId)).every((e) => e.actor !== 'agent')).toBe(true);
  });

  test('ingest through call_tool pauses for approval (S20, S35)', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f, {
      userSources: new Set(['make 3 clips from https://youtu.be/abc']),
    });
    const out = await invokeTool(ctx, r, 'call_tool', {
      name: 'ingest',
      args: { source: '~/.ssh/id_rsa' },
    });
    expect(out.pause).toMatchObject({
      reason: 'approval',
      kind: 'source',
      sources: ['~/.ssh/id_rsa'],
    });
  });

  test('describe_tool returns the description and input schema', async () => {
    const f = await fixtureProject();
    const out = await invokeTool(toolContext(f), r, 'describe_tool', { name: 'remove_item' });
    expect(out.result).toMatchObject({ name: 'remove_item', kind: 'write' });
    expect(
      (out.result as { inputSchema: { properties: object } }).inputSchema.properties,
    ).toHaveProperty('itemId');
  });
});

describe('update_todos (step 18)', () => {
  const r = buildRegistry(noImages);

  test('two in_progress items fail validation', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f);
    await expect(
      invokeTool(ctx, r, 'update_todos', {
        items: [
          { text: 'a', status: 'in_progress' },
          { text: 'b', status: 'in_progress' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(ctx.todos).toEqual([]);
  });

  test('a valid list is emitted and makes no history entry', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f);
    const before = (await f.engine.history(f.projectId)).length;
    const items = [
      { text: 'storyboard', status: 'done' as const },
      { text: 'fill', status: 'in_progress' as const },
      { text: 'review', status: 'pending' as const },
    ];
    await invokeTool(ctx, r, 'update_todos', { items });
    expect(ctx.todos).toEqual([items]);
    expect((await f.engine.history(f.projectId)).length).toBe(before);
  });
});

describe('undo_my_last_edit (step 4, S24)', () => {
  const r = buildRegistry(noImages);

  test('cannot undo a user edit: with no run edit it fails, the user edit stays', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f);
    await expect(invokeTool(ctx, r, 'undo_my_last_edit', {})).rejects.toMatchObject({
      code: 'NOTHING_TO_UNDO',
    });
    expect(
      (await f.engine.getProject(f.projectId)).sequences[0]!.videoTracks[0]!.items,
    ).toHaveLength(1);
  });

  test('undoes only this run’s newest entry, never the user’s later edit', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f);
    await invokeTool(ctx, r, 'get_sequence', { sequenceId: f.sequenceId });
    await invokeTool(ctx, r, 'update_sequence', { sequenceId: 's1', name: 'agent 1' });
    await invokeTool(ctx, r, 'update_clip', {
      sequenceId: 's1',
      itemId: ctx.aliases.aliasOf(f.v1),
      volume: 0.4,
    });
    await f.engine.applyOp(
      f.projectId,
      { op: 'addSequence', args: { name: 'user seq' } },
      { actor: 'user' },
    );
    await invokeTool(ctx, r, 'undo_my_last_edit', {});
    const p = await f.engine.getProject(f.projectId);
    expect(p.sequences.map((s) => s.name).sort()).toEqual(['agent 1', 'user seq']);
    expect(
      p.sequences.find((s) => s.id === f.sequenceId)!.videoTracks[0]!.items[0],
    ).not.toHaveProperty('volume', 0.4);
  });

  test('fails when the entry’s keys were changed since', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f);
    await invokeTool(ctx, r, 'get_sequence', { sequenceId: f.sequenceId });
    await invokeTool(ctx, r, 'update_sequence', { sequenceId: 's1', name: 'agent' });
    await f.engine.applyOp(
      f.projectId,
      { op: 'updateSequence', args: { sequenceId: f.sequenceId, name: 'user' } },
      { actor: 'user' },
    );
    await expect(invokeTool(ctx, r, 'undo_my_last_edit', {})).rejects.toMatchObject({
      code: 'UNDO_CONFLICT',
    });
    expect((await f.engine.getProject(f.projectId)).sequences[0]!.name).toBe('user');
  });
});
