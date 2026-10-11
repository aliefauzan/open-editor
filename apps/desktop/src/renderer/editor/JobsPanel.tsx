// Job rows (app spec "Error handling"): running jobs with progress; a failed job keeps its row with
// the `VoxError` hint and Retry. `JOB_CONFLICT` (D-15) lists the conflicting items, each clickable
// (selects it in its sequence), and Retry runs the job again on the current state.
import { useCtx, useJobs } from './context.tsx';
import { conflictItems } from './jobs.ts';

export function JobsPanel() {
  const { jobs, editor } = useCtx();
  const rows = useJobs((s) => s.rows).filter(
    (r) => r.status === 'running' || r.status === 'failed',
  );
  if (rows.length === 0) return null;
  return (
    <ul
      aria-label="Jobs"
      className="flex flex-col gap-1 border-t border-neutral-800 p-2 text-[11px]"
    >
      {rows.map((r) => {
        const items = r.error?.code === 'JOB_CONFLICT' ? conflictItems(r.error) : [];
        return (
          <li key={r.id} data-job-kind={r.kind} className="rounded bg-neutral-900 p-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              {r.status === 'running' ? (
                <span className="text-neutral-400">{Math.round(r.progress * 100)} %</span>
              ) : (
                <span className="text-red-400">failed</span>
              )}
            </div>
            {r.status === 'running' && r.message && <p className="text-neutral-500">{r.message}</p>}
            {r.error && (
              <div role="alert" className="mt-1">
                <p className="text-red-300">{r.error.message}</p>
                {r.error.hint && <p className="text-neutral-400">{r.error.hint}</p>}
                {items.length > 0 && (
                  <ul aria-label="Conflicting items" className="mt-1 flex flex-wrap gap-1">
                    {items.map((it) => (
                      <li key={it.key}>
                        <button
                          type="button"
                          className="rounded bg-neutral-800 px-1 underline"
                          disabled={!it.itemId}
                          onClick={() => {
                            const st = editor.getState();
                            if (it.sequenceId) st.setSequence(it.sequenceId);
                            if (it.itemId) st.select(it.itemId);
                          }}
                        >
                          {it.itemId ?? it.key}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-1 flex gap-1">
                  {r.retry && (
                    <button
                      type="button"
                      className="rounded bg-neutral-700 px-2"
                      onClick={() => {
                        jobs.getState().dismiss(r.id);
                        r.retry!();
                      }}
                    >
                      Retry
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded bg-neutral-800 px-2"
                    onClick={() => jobs.getState().dismiss(r.id)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
