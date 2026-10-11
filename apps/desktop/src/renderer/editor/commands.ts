// What each editor command does (app spec "Main editor" → Keyboard, Top bar). The keyboard map, the
// native menu bar and the top bar buttons all run commands through `runCommand`.
import type { VoxApi } from '../../shared/api.ts';
import type { MenuCommand } from '../../shared/commands.ts';
import {
  addTextOp,
  bladeOp,
  copyItems,
  deleteOp,
  duplicateOp,
  pasteOp,
  rippleDeleteOp,
  seqOf,
} from './editing.ts';
import type { EditorStore } from './store.ts';
import { msOf, frameOf } from './time.ts';
import type { UiStore } from './ui-store.ts';

/** The preview player as the commands see it (PreviewPanel implements it). */
export interface PlayerControl {
  play(rate?: number): void;
  pause(): void;
  seekMs(ms: number): void;
  isPlaying(): boolean;
}

export interface CommandDeps {
  vox: VoxApi;
  editor: EditorStore;
  ui: UiStore;
  player: { current: PlayerControl | null };
  /** For undo/redo inside a text field (native text undo). */
  doc?: Document;
}

export function isEditable(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'range', 'button', 'submit'].includes(type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

export function createCommandRunner(d: CommandDeps): (c: MenuCommand) => void {
  const doc = d.doc ?? (typeof document === 'undefined' ? undefined : document);
  return (c) => {
    const e = d.editor.getState();
    const ui = d.ui.getState();
    const s = seqOf(e.project, e.sequenceId);
    const fps = s?.canvas.fps ?? { num: 30, den: 1 };
    const send = (call: ReturnType<typeof deleteOp>) => {
      if (call) void e.apply(call);
    };
    const seek = (ms: number) => {
      const t = Math.max(0, ms);
      e.setPlayhead(t);
      d.player.current?.seekMs(t);
    };
    switch (c) {
      case 'undo':
      case 'redo':
        if (doc && isEditable(doc.activeElement)) {
          doc.execCommand(c);
          return;
        }
        void (c === 'undo' ? e.undo() : e.redo());
        return;
      case 'copy':
        if (s && e.selection.length > 0) ui.set({ clipboard: copyItems(s, e.selection) });
        return;
      case 'paste':
        if (s) send(pasteOp(s, ui.clipboard, e.playheadMs));
        return;
      case 'duplicate':
        if (s) send(duplicateOp(s, e.selection));
        return;
      case 'delete':
        if (s) send(deleteOp(s, e.selection));
        e.setSelection([]);
        return;
      case 'rippleDelete':
        if (s) send(rippleDeleteOp(s, e.selection));
        e.setSelection([]);
        return;
      case 'blade':
        if (s) send(bladeOp(s, e.selection, e.playheadMs));
        return;
      case 'playPause': {
        const p = d.player.current;
        if (!p) return;
        if (p.isPlaying()) p.pause();
        else p.play(1);
        return;
      }
      case 'pause':
        d.player.current?.pause();
        return;
      case 'shuttleForward': {
        const p = d.player.current;
        if (!p) return;
        // each L press doubles the speed up to 4x
        const rate = p.isPlaying() ? Math.min(4, ui.rate * 2) : 1;
        ui.set({ rate });
        p.play(rate);
        return;
      }
      case 'shuttleBack':
        // the player cannot run backwards: J pauses and steps back one second
        d.player.current?.pause();
        seek(e.playheadMs - 1000);
        return;
      case 'frameBack':
      case 'frameForward': {
        d.player.current?.pause();
        const f = frameOf(e.playheadMs, fps) + (c === 'frameBack' ? -1 : 1);
        seek(msOf(Math.max(0, f), fps));
        return;
      }
      case 'markIn':
        ui.set({
          inMs: e.playheadMs,
          outMs: ui.outMs !== null && ui.outMs <= e.playheadMs ? null : ui.outMs,
        });
        return;
      case 'markOut':
        ui.set({
          outMs: e.playheadMs,
          inMs: ui.inMs !== null && ui.inMs >= e.playheadMs ? null : ui.inMs,
        });
        return;
      case 'zoomIn':
        ui.zoom(1);
        return;
      case 'zoomOut':
        ui.zoom(-1);
        return;
      case 'addText':
        if (s) send(addTextOp(s, e.playheadMs));
        return;
      case 'newSequence': {
        const n = (e.project?.sequences.length ?? 0) + 1;
        send({ op: 'addSequence', args: { name: `Sequence ${n}` } });
        return;
      }
      case 'saveSnapshot':
        ui.set({ snapshotsOpen: true });
        return;
      case 'export':
        ui.set({ exportOpen: true, stage: 'export' });
        return;
      case 'settings':
        ui.set({ settingsOpen: true });
        return;
      case 'toggleSafeArea':
        ui.set({ safeArea: !ui.safeArea });
        return;
      case 'renderFrame':
        void renderFrame(d);
        return;
    }
  };
}

/** "Render this frame": a still of the exact frame through the `frames` job. */
export async function renderFrame(d: CommandDeps): Promise<void> {
  const e = d.editor.getState();
  if (!e.projectId || !e.sequenceId) return;
  const projectId = e.projectId;
  try {
    const jobId = (await d.vox.jobs.start('frames', {
      projectId,
      sequenceId: e.sequenceId,
      atMs: [e.playheadMs],
    })) as string;
    for (;;) {
      const j = (await d.vox.jobs.get(jobId)) as {
        status: string;
        result?: { paths: string[] };
        error?: unknown;
      };
      if (j.status === 'done' && j.result?.paths[0]) {
        d.ui.getState().set({ still: projectFileUrl(projectId, j.result.paths[0]) });
        return;
      }
      if (j.status === 'failed' || j.status === 'cancelled') {
        e.toast(
          j.error ?? { code: 'RENDER_FAILED', message: 'The frame did not render', hint: '' },
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch (err) {
    e.toast(err);
  }
}

/** `vox-media://p/<id>/<rel>` for an absolute path inside the project folder. */
export function projectFileUrl(projectId: string, abs: string): string {
  const i = abs.indexOf(`/${projectId}/`);
  const rel = i < 0 ? abs : abs.slice(i + projectId.length + 2);
  return `vox-media://p/${projectId}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}
