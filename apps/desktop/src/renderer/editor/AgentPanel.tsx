// Agent panel (app spec "Main editor" → Agent panel): in 4-core a placeholder with a link to
// settings; phase 13 fills in the chat, pause cards and activity log.
import { useCtx } from './context.tsx';

export function AgentPanel() {
  const { run } = useCtx();
  return (
    <aside
      id="agent-panel"
      tabIndex={-1}
      aria-label="Agent"
      className="flex h-full flex-col gap-3 bg-neutral-900 p-4"
    >
      <h2 className="text-sm font-semibold">Agent</h2>
      <p className="text-xs leading-relaxed text-neutral-400">
        The editing agent arrives in a later version. Everything here can be edited by hand
        meanwhile.
      </p>
      <button
        type="button"
        className="self-start rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
        onClick={() => run('settings')}
      >
        Open settings
      </button>
    </aside>
  );
}
