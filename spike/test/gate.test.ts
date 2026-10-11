import { describe, expect, it } from 'vitest';
import { gateOutcome, type GateInput } from '../lib/gate.ts';

const allPass: GateInput = {
  pass: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true, 9: true },
  item4: { opaque: true },
  marginPct: 20.8,
};

describe('gateOutcome', () => {
  it('all pass selects the whole-sequence render', () => {
    expect(gateOutcome(allPass)).toEqual({
      allPass: true,
      outcomes: ['whole-sequence render; NTSC go; no pre-render cache'],
    });
  });

  it('item 3 failing selects the hybrid export', () => {
    expect(gateOutcome({ ...allPass, pass: { ...allPass.pass, 3: false } }).outcomes).toEqual([
      'hybrid export through the layer renderer',
    ]);
  });

  it('an unmeasured item counts as failed', () => {
    const rest = { ...allPass.pass };
    delete rest[5];
    expect(gateOutcome({ ...allPass, pass: rest }).outcomes).toContain(
      'hybrid export through the layer renderer',
    );
  });

  it('item 4 failing only in opaque mode selects the sandbox fallback', () => {
    expect(
      gateOutcome({ ...allPass, item4: { opaque: false, sameOrigin: true } }).outcomes,
    ).toEqual(['allow-same-origin sandbox fallback on vox-media://']);
  });

  it('item 4 failing in both modes, or item 6 failing, selects the Preview fallback', () => {
    expect(
      gateOutcome({ ...allPass, item4: { opaque: false, sameOrigin: false } }).outcomes,
    ).toEqual(['app "Preview fallback"']);
    expect(gateOutcome({ ...allPass, pass: { ...allPass.pass, 6: false } }).outcomes).toEqual([
      'app "Preview fallback"',
    ]);
  });

  it('a margin under 20 % selects the pre-render cache; 20 % does not', () => {
    expect(gateOutcome({ ...allPass, marginPct: 19.9 }).outcomes).toEqual([
      'pre-render cache (10a)',
    ]);
    expect(gateOutcome({ ...allPass, marginPct: 20 }).allPass).toBe(true);
  });

  it('item 9 failing selects the NTSC fallback', () => {
    expect(gateOutcome({ ...allPass, pass: { ...allPass.pass, 9: false } }).outcomes).toEqual([
      'NTSC fallback: integer rates only',
    ]);
  });
});
