import { describe, expect, it } from 'vitest';
import { runTimelineBench } from '../../bench/timeline-runner.ts';

// GATE 4 prototype checks in a real browser (Playwright Chromium headless shell; needs
// `pnpm -C apps/desktop exec playwright install chromium`). Asserts the checks, not fps:
// fps is measured by `pnpm -C apps/desktop bench:timeline` under the bench lock. Not on CI
// (no Playwright browser there yet; phase 08 adds Playwright to CI with the Electron E2E).
describe.skipIf(process.env['CI'])('timeline prototype (GATE 4)', () => {
  it('linked V1/A1 drag ends with equal startMs and a marquee selects exactly 50 items', async () => {
    const run = await runTimelineBench({
      attempts: 1,
      headed: false,
      gestureMs: 300,
      browser: 'shell',
    });
    const [a] = run.attempts;
    expect(a!.linkedCheck).toMatchObject({ pass: true, movedMs: 5000, followedDuringDrag: true });
    expect(a!.linkedCheck.draggedStartMs).toBe(a!.linkedCheck.partnerStartMs);
    expect(a!.marqueeCheck).toEqual({ pass: true, expected: 50, selected: 50, domSelected: 50 });
    for (const g of [a!.drag, a!.trim, a!.linkedDrag]) expect(g.updates).toBeGreaterThan(0);
  });
});
