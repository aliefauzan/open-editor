// Cue timing check (styles spec "Testing", D-14): the frames of a fixture render are measured by
// per-frame pixel difference; a `cut` or `appear` cue sits within 1 frame of a difference spike, a
// `land` cue within 1 frame of where motion falls below the threshold, a `move` cue within 2 frames of
// peak motion. `hero` cues are not measured (phase 06 risk table: only cue types it can measure).

export type CueType = 'cut' | 'move' | 'land' | 'appear' | 'hero';

export interface CueAt {
  name: string;
  type: CueType;
  /** Frame index relative to the scene start (`diffs` index). */
  frame: number;
}

export interface CueFinding {
  cue: string;
  message: string;
}

/**
 * Mean absolute difference of each frame from the one before (0–255 scale). `frames` are equal-size
 * grey images; `diffs[0]` compares frame 0 with `before` (the frame ahead of the window), or is 0.
 */
export function frameDiffs(frames: readonly Uint8Array[], before?: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const a = i === 0 ? before : frames[i - 1];
    const b = frames[i]!;
    if (!a) {
      out.push(0);
      continue;
    }
    let s = 0;
    for (let k = 0; k < b.length; k++) s += Math.abs(b[k]! - a[k]!);
    out.push(b.length ? s / b.length : 0);
  }
  return out;
}

/**
 * Differences of render frames [s, e). A window that starts at frame 0 is compared with the black
 * canvas the render starts from (compile's root background), so a cue at a scene's first frame is
 * measurable there too.
 */
export function windowDiffs(gray: readonly Uint8Array[], s: number, e: number): number[] {
  const frames = gray.slice(s, e);
  const before = s > 0 ? gray[s - 1] : frames[0] && new Uint8Array(frames[0].length);
  return frameDiffs(frames, before);
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Thresholds from the window's noise floor (encoder noise on a still frame is well under 1). */
export function thresholds(diffs: readonly number[]): { spike: number; motion: number } {
  const noise = median(diffs);
  return { spike: Math.max(2, 4 * noise), motion: Math.max(0.5, 2 * noise) };
}

const at = (d: readonly number[], i: number) => (i >= 0 && i < d.length ? d[i]! : 0);

export function cueTimingFindings(diffs: readonly number[], cues: readonly CueAt[]): CueFinding[] {
  const { spike, motion } = thresholds(diffs);
  const out: CueFinding[] = [];
  for (const c of cues) {
    const f = c.frame;
    if (c.type === 'hero') continue;
    if (f < 0 || f >= diffs.length) {
      out.push({ cue: c.name, message: `cue ${c.name} at frame ${f} is outside the scene` });
      continue;
    }
    if (c.type === 'cut' || c.type === 'appear') {
      let hit = false;
      for (let j = f - 1; j <= f + 1; j++) {
        const v = at(diffs, j);
        if (v >= spike && v >= at(diffs, j - 1) && v >= at(diffs, j + 1)) hit = true;
      }
      if (!hit) {
        out.push({
          cue: c.name,
          message: `${c.type} cue ${c.name} at frame ${f} has no picture change within 1 frame (spike ≥ ${spike.toFixed(1)})`,
        });
      }
    } else if (c.type === 'land') {
      let hit = false;
      for (let j = f - 1; j <= f + 1; j++) {
        if (at(diffs, j - 1) >= motion && at(diffs, j) < motion && at(diffs, j + 1) < motion) {
          hit = true;
        }
      }
      if (!hit) {
        out.push({
          cue: c.name,
          message: `land cue ${c.name} at frame ${f}: motion does not settle within 1 frame`,
        });
      }
    } else {
      let peak = -1;
      for (let j = Math.max(1, f - 6); j <= Math.min(diffs.length - 1, f + 6); j++) {
        if (peak < 0 || diffs[j]! > diffs[peak]!) peak = j;
      }
      if (peak < 0 || Math.abs(peak - f) > 2 || diffs[peak]! < motion) {
        out.push({
          cue: c.name,
          message: `move cue ${c.name} at frame ${f}: peak motion is at frame ${peak}`,
        });
      }
    }
  }
  return out;
}
