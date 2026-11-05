import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

export function EvalTab({ onOpen }: { onOpen: (decisionId: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['eval'], queryFn: api.evalResults });
  const run = useMutation({ mutationFn: api.runEval, onSuccess: (r) => qc.setQueryData(['eval'], r) });
  const r = run.data ?? q.data;

  return (
    <div className="card eval">
      <div className="row">
        <h2>Evaluation</h2>
        <button className="primary" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? 'Running (replay)…' : 'Run all cases (replay)'}
        </button>
      </div>
      <p className="muted">
        Each case seeds a world, fires a trigger (optionally with injected faults) and asserts the decision, the tools used,
        the constraints, the actions, the read-back validation and the recovery path. Replay mode uses recorded LLM
        responses, so it is deterministic and spends no quota. Running it re-seeds the database.
      </p>
      {run.error && <p className="error">{(run.error as Error).message}</p>}
      {!r && <p className="muted">No results yet. Run it here or with <code>npm run eval</code>.</p>}
      {r && (
        <>
          <p>
            <strong>
              {r.passed}/{r.total} passed
            </strong>{' '}
            <span className="muted">
              · mode {r.mode} · model {r.model} · {new Date(r.startedAt).toLocaleString()}
            </span>
          </p>
          <table className="tbl">
            <thead>
              <tr>
                <th></th>
                <th>Case</th>
                <th>What it checks</th>
                <th>Final state</th>
                <th>Decision</th>
                <th>LLM turns</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {r.results.map((c) => (
                <tr key={c.name} className={c.pass ? '' : 'failrow'}>
                  <td>{c.pass ? <span className="ok">✓</span> : <span className="bad">✗</span>}</td>
                  <td className="mono">{c.name}</td>
                  <td className="small">
                    {c.description}
                    {c.failures.map((f) => (
                      <div key={f} className="bad">
                        {f}
                      </div>
                    ))}
                  </td>
                  <td>{c.finalState}</td>
                  <td>
                    {c.decision ?? '—'} {c.quantity ?? ''}
                  </td>
                  <td>
                    {c.llmTurns}
                    {c.cacheHits ? ' (replayed)' : ''}
                  </td>
                  <td>{c.decisionId && <button onClick={() => onOpen(c.decisionId!)}>Open trace</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
