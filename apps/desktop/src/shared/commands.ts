// Editor commands shared by the native menu bar (main) and the keyboard map (renderer), app spec
// "Main editor" → Keyboard: space play/pause, J/K/L, I/O in/out, B blade, delete, shift+delete ripple
// delete, cmd+C/V/D, cmd+Z/shift+cmd+Z, arrow keys frame step, +/- zoom.

export const MENU_COMMANDS = [
  'undo',
  'redo',
  'copy',
  'paste',
  'duplicate',
  'delete',
  'rippleDelete',
  'blade',
  'playPause',
  'shuttleBack',
  'pause',
  'shuttleForward',
  'markIn',
  'markOut',
  'frameBack',
  'frameForward',
  'zoomIn',
  'zoomOut',
  'addText',
  'newSequence',
  'saveSnapshot',
  'export',
  'settings',
  'toggleSafeArea',
  'renderFrame',
] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

interface Binding {
  key: string | string[];
  cmd?: boolean;
  shift?: boolean;
}

/** Key bindings; `cmd` is ⌘ on macOS (ctrl elsewhere). Keys compare case-insensitively. */
export const KEYS: Partial<Record<MenuCommand, Binding>> = {
  undo: { key: 'z', cmd: true },
  redo: { key: 'z', cmd: true, shift: true },
  copy: { key: 'c', cmd: true },
  paste: { key: 'v', cmd: true },
  duplicate: { key: 'd', cmd: true },
  delete: { key: ['Backspace', 'Delete'] },
  rippleDelete: { key: ['Backspace', 'Delete'], shift: true },
  blade: { key: 'b' },
  playPause: { key: ' ' },
  shuttleBack: { key: 'j' },
  pause: { key: 'k' },
  shuttleForward: { key: 'l' },
  markIn: { key: 'i' },
  markOut: { key: 'o' },
  frameBack: { key: 'ArrowLeft' },
  frameForward: { key: 'ArrowRight' },
  zoomIn: { key: ['+', '='] },
  zoomOut: { key: ['-', '_'] },
};

/** Electron accelerator strings for the menu (display; see main for which ones register). */
export const ACCELERATORS: Partial<Record<MenuCommand, string>> = {
  undo: 'CmdOrCtrl+Z',
  redo: 'Shift+CmdOrCtrl+Z',
  duplicate: 'CmdOrCtrl+D',
  delete: 'Backspace',
  rippleDelete: 'Shift+Backspace',
  blade: 'B',
  playPause: 'Space',
  shuttleBack: 'J',
  pause: 'K',
  shuttleForward: 'L',
  markIn: 'I',
  markOut: 'O',
  frameBack: 'Left',
  frameForward: 'Right',
  zoomIn: 'Plus',
  zoomOut: '-',
  export: 'CmdOrCtrl+E',
  settings: 'CmdOrCtrl+,',
  saveSnapshot: 'Shift+CmdOrCtrl+S',
  newSequence: 'CmdOrCtrl+T',
};

const same = (a: string, b: string) =>
  a.length === 1 && b.length === 1 ? a.toLowerCase() === b.toLowerCase() : a === b;

/** The command a key press means, or null. */
export function commandForKey(e: KeyLike): MenuCommand | null {
  const cmd = Boolean(e.metaKey || e.ctrlKey);
  const shift = Boolean(e.shiftKey);
  for (const [name, b] of Object.entries(KEYS) as [MenuCommand, Binding][]) {
    const keys = Array.isArray(b.key) ? b.key : [b.key];
    if (!keys.some((k) => same(k, e.key))) continue;
    if (Boolean(b.cmd) !== cmd) continue;
    // `+` needs shift on most layouts; zoom keys ignore shift
    if (name !== 'zoomIn' && name !== 'zoomOut' && Boolean(b.shift) !== shift) continue;
    return name;
  }
  return null;
}
