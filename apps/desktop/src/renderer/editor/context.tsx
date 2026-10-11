// One editor per window: the engine-backed store, the view store, the player handle and the command
// runner, shared through React context.
import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { VoxApi } from '../../shared/api.ts';
import type { MenuCommand } from '../../shared/commands.ts';
import { createAgentStore, type AgentState, type AgentStore } from './agent-store.ts';
import { createCommandRunner, type PlayerControl } from './commands.ts';
import { createJobsStore, type JobsState, type JobsStore } from './jobs.ts';
import { createEditorStore, type EditorState, type EditorStore } from './store.ts';
import { createUiStore, type UiState, type UiStore } from './ui-store.ts';

export interface EditorContext {
  vox: VoxApi;
  editor: EditorStore;
  ui: UiStore;
  jobs: JobsStore;
  agent: AgentStore;
  player: { current: PlayerControl | null };
  run(c: MenuCommand): void;
}

export function createEditorContext(vox: VoxApi): EditorContext {
  const editor = createEditorStore(vox);
  const ui = createUiStore();
  const player: EditorContext['player'] = { current: null };
  const jobs = createJobsStore(vox);
  const agent = createAgentStore(vox);
  return {
    vox,
    editor,
    ui,
    jobs,
    agent,
    player,
    run: createCommandRunner({ vox, editor, ui, player }),
  };
}

const Ctx = createContext<EditorContext | null>(null);

export function EditorProvider(props: { value: EditorContext; children: ReactNode }) {
  return <Ctx.Provider value={props.value}>{props.children}</Ctx.Provider>;
}

export function useCtx(): EditorContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCtx outside EditorProvider');
  return c;
}

export function useEditor<T>(sel: (s: EditorState) => T): T {
  return useStore(useCtx().editor, sel);
}

export function useUi<T>(sel: (s: UiState) => T): T {
  return useStore(useCtx().ui, sel);
}

export function useJobs<T>(sel: (s: JobsState) => T): T {
  return useStore(useCtx().jobs, sel);
}

export function useAgent<T>(sel: (s: AgentState) => T): T {
  return useStore(useCtx().agent, sel);
}

/** For selectors that build a small object each time: re-renders only when a field changes. */
export function useEditorShallow<T>(sel: (s: EditorState) => T): T {
  return useStore(useCtx().editor, useShallow(sel));
}
