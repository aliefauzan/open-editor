// Phase 13 steps 3 and 3b, E2E with the mock agent model of the test build (`VOX_E2E_AGENT=mock`, see
// src/engine-host/e2e-agent.ts; no provider, no key). Step 3: an agent run's edits appear live, an
// unnamed source pauses for approval, "Undo this run" takes the run back, and the clip exports as a
// draft MP4 + SRT with the sequence's duration; "Add style beats" on a quick clip adds scenes and
// "Undo this run" returns the plain clip. Step 3b (D-15): "Confirm plan first" shows the plan card
// before any edit, "Stop" leaves the history as it was and "Run plan" applies it; the clipper's tighten
// card applies only the ticked ranges (one undo entry per sequence); during a run the marked sequence
// tab takes a user trim, and the run record's change note for the next step lists it; the todo list
// shows in the run card.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { runsDir } from '@vox/agent';
import {
  SEED,
  answerDialog,
  durationMs,
  exportTo,
  projectState,
  seqEnd,
  start,
  tempDir,
  vox,
  type SeqLike,
  type Session,
} from './helpers.ts';

// quick clips, a few agent runs and an export per test
test.describe.configure({ timeout: 1_200_000 });

const sessions: Session[] = [];
test.afterAll(async () => {
  for (const s of sessions) await s.app.close().catch(() => undefined);
});

async function session(env: Record<string, string>): Promise<Session> {
  const s = await start({ env: { VOX_E2E_AGENT: 'mock', ...env } });
  sessions.push(s);
  return s;
}

/** Quick clips from the seed (4–8 s, seeded analysis): the editor opens on 3 sequence tabs. */
async function quickClips(s: Session): Promise<string> {
  const { page } = s;
  await page.getByLabel('Shortest clip (s)').fill('4');
  await page.getByLabel('Longest clip (s)').fill('8');
  await answerDialog(s, [SEED('mp4')]);
  await page.getByRole('button', { name: 'Choose file…' }).first().click();
  await page.getByTestId('editor').waitFor({ timeout: 900_000 });
  await page.getByTestId('next-steps').waitFor();
  await expect(seqTabs(page)).toHaveCount(3);
  const list = await vox<{ id: string }[]>(page, 'projects.list');
  return list[0]!.id;
}

const seqTabs = (page: Page) => page.getByRole('tablist', { name: 'Sequences' }).getByRole('tab');

async function openSeq(page: Page, pid: string): Promise<SeqLike> {
  const id = await seqTabs(page)
    .and(page.locator('[aria-selected="true"]'))
    .getAttribute('data-sequence-id');
  const st = await projectState(page, pid);
  return st.project.sequences.find((q) => q.id === id)!;
}

const scenes = (q: SeqLike) =>
  q.videoTracks.flatMap((t) => t.items).filter((i) => i.type === 'scene').length;

const runCard = (page: Page) => page.getByTestId('agent-run').first();

async function waitStatus(page: Page, status: string, timeout = 300_000) {
  await expect(runCard(page)).toHaveAttribute('data-status', status, { timeout });
}

async function send(page: Page, text: string) {
  await page.getByLabel('Message to the agent').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function styleBeats(page: Page) {
  await page.getByRole('button', { name: 'Add style', exact: true }).click();
  await page
    .getByRole('menuitem', { name: /^Add style beats: vox/i })
    .first()
    .click();
}

test('step 3: live edits, source approval, Undo this run, export; Add style beats and undo', async () => {
  const s = await session({ VOX_E2E_AGENT_SOURCE: SEED('mov') });
  const { page } = s;
  const pid = await quickClips(s);
  await expect(page.getByTestId('agent-mode')).toHaveText('e2e-mock · tools');
  const plain = await openSeq(page, pid);
  expect(scenes(plain)).toBe(0);

  await send(page, 'add b-roll and two title beats');
  const source = page.getByTestId('pause-source');
  await expect(source).toContainText('talking-head-20s.mov', { timeout: 120_000 });
  await source.getByRole('button', { name: 'Allow' }).click();
  // the scenes appear in the timeline while the run goes on (one live edit per tool call)
  await expect.poll(async () => scenes(await openSeq(page, pid)), { timeout: 300_000 }).toBe(2);
  await waitStatus(page, 'completed');
  const todos = runCard(page).getByTestId('agent-todos');
  await expect(todos.locator('[data-status="done"]')).toHaveCount(2);
  await expect(runCard(page).getByTestId('activity-log')).toContainText('Edited in timeline');

  await runCard(page).getByRole('button', { name: 'Undo this run' }).click();
  await expect.poll(async () => scenes(await openSeq(page, pid)), { timeout: 30_000 }).toBe(0);

  const out = tempDir('vox-e2e-agent-');
  await exportTo(s, out, { formats: ['mp4', 'srt'], quality: 'draft' });
  const mp4 = readdirSync(out).find((f) => f.endsWith('.mp4'))!;
  const srt = readdirSync(out).find((f) => f.endsWith('.srt'))!;
  expect(readFileSync(join(out, srt), 'utf8')).toMatch(/-->/);
  const end = seqEnd(await openSeq(page, pid));
  expect(Math.abs(durationMs(join(out, mp4)) - end)).toBeLessThan(150);

  // "Add style beats" (the vox style) on the quick clip: a stylize run adds its scenes
  await styleBeats(page);
  await waitStatus(page, 'completed');
  await expect(runCard(page)).toContainText('stylize');
  expect(scenes(await openSeq(page, pid))).toBe(2);
  await runCard(page).getByRole('button', { name: 'Undo this run' }).click();
  await expect.poll(async () => scenes(await openSeq(page, pid)), { timeout: 30_000 }).toBe(0);
  expect(s.errors).toEqual([]);
});

test('step 3b: Confirm plan first — the plan card comes before any edit; Stop, then Run plan', async () => {
  const s = await session({ VOX_E2E_AGENT_MODE: 'plan' });
  const { page } = s;
  const pid = await quickClips(s);
  await expect(page.getByTestId('agent-mode')).toHaveText('e2e-mock · plan');
  await page.getByLabel('Confirm plan first').check();

  await styleBeats(page);
  const plan = page.getByTestId('pause-plan');
  await expect(plan).toContainText('vox/kinetic-serif', { timeout: 120_000 });
  const before = await vox<unknown[]>(page, 'history.list', pid);
  expect(scenes(await openSeq(page, pid))).toBe(0);
  await plan.getByRole('button', { name: 'Stop' }).click();
  await waitStatus(page, 'stopped');
  expect(await vox<unknown[]>(page, 'history.list', pid)).toEqual(before);
  expect(scenes(await openSeq(page, pid))).toBe(0);

  await styleBeats(page);
  await expect(page.getByTestId('pause-plan')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('pause-plan').getByRole('button', { name: 'Run plan' }).click();
  await waitStatus(page, 'completed');
  expect(scenes(await openSeq(page, pid))).toBe(2);
  expect(s.errors).toEqual([]);
});

test('step 3b: tighten card, the tab marker takes a user trim, change note, todos', async () => {
  const s = await session({ VOX_E2E_AGENT_DELAY_MS: '1500' });
  const { page } = s;
  const pid = await quickClips(s);

  // longer clips (6–12 s) hold more than one pause each (as in the agent D-15 test)
  await send(page, `make 2 vox clips of 6-12 s from ${SEED('mp4')}`);
  // one tighten card per sequence: in the first list with two or more ranges untick the second, then
  // Apply; Apply every other list as it is
  const applied: { seq: string; keys: string[]; unticked?: string }[] = [];
  for (let i = 0; i < 6; i++) {
    const card = page.getByTestId('pause-tighten');
    const next = await Promise.race([
      card.waitFor({ timeout: 300_000 }).then(() => 'card' as const),
      page
        .getByTestId('agent-editing')
        .first()
        .waitFor({ timeout: 300_000 })
        .then(() => 'marker' as const),
    ]);
    if (next === 'marker') break;
    const seq = (await card.getAttribute('data-sequence-id'))!;
    const rows = card.locator('[data-word-key]');
    const keys = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-word-key')!));
    let unticked: string | undefined;
    if (keys.length >= 2 && !applied.some((a) => a.unticked)) {
      await rows.nth(1).getByRole('checkbox').uncheck();
      unticked = keys[1];
    }
    await card.getByRole('button', { name: 'Apply' }).click();
    applied.push({ seq, keys, ...(unticked && { unticked }) });
    await expect(
      page.locator(`[data-testid="pause-tighten"][data-sequence-id="${seq}"]`),
    ).toHaveCount(0);
  }
  // a 20 s source may hold fewer clips of 6–12 s than asked; every clip gets its card
  expect(applied.length).toBeGreaterThanOrEqual(1);
  expect(
    applied.some((a) => a.unticked),
    'a list with two or more ranges',
  ).toBe(true);

  // during a stylize sub-run: the marked tab takes a user trim
  const marker = page.getByTestId('agent-editing').first();
  await marker.waitFor({ timeout: 300_000 });
  const tab = page.getByRole('tab').filter({ has: marker });
  const seqId = (await tab.getAttribute('data-sequence-id'))!;
  await tab.click();
  const st = await projectState(page, pid);
  const q = st.project.sequences.find((x) => x.id === seqId)!;
  const last = q.videoTracks[0]!.items.at(-1)!;
  await vox(page, 'ops.apply', {
    projectId: pid,
    op: 'trimItem',
    args: {
      sequenceId: seqId,
      itemId: last.id,
      edge: 'end',
      toMs: last.startMs + last.durationMs - 300,
    },
    baseVersion: st.version,
  });
  await waitStatus(page, 'completed', 600_000);
  await expect(page.getByTestId('agent-editing')).toHaveCount(0);

  const runId = (await runCard(page).getAttribute('data-run-id'))!;
  const history = await vox<
    { runId?: string; op?: string; args?: { sequenceId?: string; wordKeys?: string[] } }[]
  >(page, 'history.list', pid);
  // one undo entry per sequence; the unticked pause stays
  for (const a of applied) {
    const cuts = history.filter(
      (e) => e.runId === runId && e.op === 'removePauses' && e.args?.sequenceId === a.seq,
    );
    expect(cuts, a.seq).toHaveLength(1);
    const cut = cuts[0]!.args?.wordKeys ?? a.keys;
    if (a.unticked) {
      expect(cut).toContain(a.keys[0]);
      expect(cut).not.toContain(a.unticked);
    }
  }

  const record = readFileSync(join(runsDir(s.home.projectsDir, pid), `${runId}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; lines?: string[] });
  const notes = record.filter((l) => l.type === 'changeNote').flatMap((l) => l.lines ?? []);
  expect(notes.some((n) => /by user: trimItem/.test(n))).toBe(true);
  await expect(runCard(page).getByTestId('agent-todos')).toBeVisible();
  expect(s.errors).toEqual([]);
});
