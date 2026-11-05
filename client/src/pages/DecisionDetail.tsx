import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isTerminal, type DecisionDoc, type ToolCallRecord } from '@purchasing/shared';
import { api, type DecisionDetail } from '../api';
import { DecisionPill, StateBadge } from '../components/StateBadge';

export function DecisionDetailView({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['decision', id],
    queryFn: () => api.decision(id),
    refetchInterval: (query) => {
      const s = query.state.data?.state;
      return !s || !isTerminal(s) ? 1000 : false;
    },
  });
  const approve = useMutation({ mutationFn: () => api.approve(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['decision', id] }) });
  const reject = useMutation({ mutationFn: () => api.reject(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['decision', id] }) });

  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.error || !q.data) return <p className="error">{(q.error as Error)?.message ?? 'Not found'}</p>;
  const d = q.data;

  return (
    <div className="detail">
      <Header d={d} />

      {d.state === 'NEEDS_APPROVAL' && (
        <div className="card approval">
          <h3>Waiting for your approval</h3>
          <ul>
            {d.approval.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <ActionTable d={d} planned />
          <div className="buttons">
            <button className="primary" disabled={approve.isPending} onClick={() => approve.mutate()}>
              Approve & execute
            </button>
            <button disabled={reject.isPending} onClick={() => reject.mutate()}>
              Reject
            </button>
          </div>
        </div>
      )}

      {d.escalation && (
        <div className="card escalation">
          <h3>Escalated to a buyer</h3>
          <p>{d.escalation.summary}</p>
          <ol>
            {d.escalation.options.map((o) => (
              <li key={o.label}>
                <strong>{o.label}</strong> — {o.detail}
              </li>
            ))}
          </ol>
        </div>
      )}

      {d.explanation && (
        <Section title="Buyer note">
          <pre className="note">{d.explanation}</pre>
        </Section>
      )}

      <div className="grid2">
        <Section title="Engine result (deterministic)">
          <Numbers d={d} />
        </Section>
        <Section title="State timeline">
          <ol className="timeline">
            {d.transitions.map((t, i) => (
              <li key={i}>
                <StateBadge state={t.to} /> <span className="small">{t.reason}</span>
              </li>
            ))}
          </ol>
        </Section>
      </div>

      <Section title={`Actions & validation`}>
        <ActionTable d={d} />
        {d.validations.length > 0 && (
          <table className="tbl">
            <thead>
              <tr>
                <th>Check</th>
                <th>Result</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {d.validations.map((v, i) => (
                <tr key={i}>
                  <td>{v.kind === 'PO' ? `read-back action #${v.actionIndex}` : 'outcome'}</td>
                  <td>{v.ok ? <span className="ok">✓ ok</span> : <span className="bad">✗ mismatch</span>}</td>
                  <td className="small">
                    {v.diffs.map((x) => `${x.field}: expected ${JSON.stringify(x.expected)}, got ${JSON.stringify(x.observed)}`).join('; ')}
                    {v.checks?.map((c) => (
                      <div key={c.name}>
                        {c.ok ? '✓' : '✗'} {c.name}: {c.detail}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d.reconciliations.length > 0 && (
          <div className="recon">
            <h4>Feedback loop</h4>
            <ol>
              {d.reconciliations.map((r, i) => (
                <li key={i}>
                  <span className={`move m-${r.move.toLowerCase()}`}>{r.move}</span> <span className="small">after {r.failure}: {r.detail}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </Section>

      <Section title={`Agent trace — ${d.toolCalls.length} tool calls, ${d.llm.turns} LLM turns${d.llm.cacheHits ? ` (${d.llm.cacheHits} replayed)` : ''}`}>
        <Trace calls={d.toolCalls} rejected={d.rejectedSubmissions} />
      </Section>

      <Section title={d.finalPurchaseOrders ? 'Purchase orders as this decision left them' : 'Purchase orders (current)'}>
        <table className="tbl">
          <thead>
            <tr>
              <th>PO</th>
              <th>Supplier</th>
              <th>Qty</th>
              <th>Pending</th>
              <th>Confirmed</th>
              <th>Status</th>
              <th>Expected</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {(d.finalPurchaseOrders ?? d.purchaseOrders).map((p) => (
              <tr key={p.poId} className={p.decisionId === d.decisionId ? 'mine' : ''}>
                <td>{p.poId}</td>
                <td>{p.supplierId}</td>
                <td>{p.qty}</td>
                <td>{p.pendingQty ?? '—'}</td>
                <td>{p.confirmedQty ?? '—'}</td>
                <td>{p.status}</td>
                <td>{p.expectedDate.slice(0, 10)}</td>
                <td>₹{p.totalCost.toLocaleString('en-IN')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function Header({ d }: { d: DecisionDetail }) {
  const t = d.trigger;
  return (
    <div className="card header">
      <div className="row">
        <h2>{d.decisionId}</h2>
        <StateBadge state={d.state} />
      </div>
      <p>
        {t.type === 'RECOMMENDATION'
          ? `Replenishment system recommends ${t.qty} × ${t.sku} at ${t.node} from ${t.supplierId}.`
          : `Supplier shortfall: ${t.poId} — supplier confirms only ${t.confirmedQty}.${t.message ? ` "${t.message}"` : ''}`}
        {d.faults.length ? <span className="muted"> Injected faults: {d.faults.join(', ')}.</span> : null}
      </p>
      <div className="row">
        <span>
          Agent decision: <DecisionPill decision={d.decision?.decision} strategy={d.decision?.strategy} />
          {d.decision?.quantity !== undefined && d.decision.decision !== 'REJECT' ? <strong> {d.decision.quantity}</strong> : null}
        </span>
        {!isTerminal(d.state) && d.state !== 'NEEDS_APPROVAL' && <span className="spinner">working…</span>}
      </div>
      {d.error && <p className="error">{d.error}</p>}
    </div>
  );
}

function Numbers({ d }: { d: DecisionDoc }) {
  const c = d.computed as any;
  const rows: [string, ReactNode][] = [];
  if (d.engine) {
    rows.push(['Engine decision', <DecisionPill decision={d.engine.decision} strategy={d.engine.strategy} />]);
    rows.push(['Rule', d.engine.rule]);
    rows.push(['Summary', d.engine.summary]);
  }
  if (c.need) {
    rows.push(['Coverage needed', `${c.need.coverageNeeded} (${c.need.demandOverHorizon} demand over ${c.need.horizon}d + ${c.need.safetyStock} safety)`]);
    rows.push(['Projected position', `${c.need.projectedPosition} (on hand + incoming ${c.need.incomingInWindow})`]);
    rows.push(['True need', c.need.trueNeed]);
    rows.push(['Days to stockout', c.need.daysToStockout ?? '—']);
  }
  if (c.constraints) {
    rows.push(['Requested (MOQ/pack)', c.constraints.requestedQty]);
    rows.push(['Cap: budget / storage', `${c.constraints.maxByBudget} / ${c.constraints.maxByStorage}`]);
    rows.push(['Feasible / binding', `${c.constraints.feasibleQty} / ${c.constraints.bindingConstraint}`]);
  }
  if (c.trustIssues?.length) rows.push(['Data issues', c.trustIssues.map((t: any) => t.message).join('; ')]);
  return (
    <>
      <table className="kv">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {c.shortfall?.candidates && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Option</th>
              <th>Qty</th>
              <th>Arrives</th>
              <th>Cost Δ</th>
              <th>On-time</th>
              <th>Before stockout</th>
              <th>Fits</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {c.shortfall.candidates.map((x: any) => (
              <tr key={x.kind + x.supplierId}>
                <td>
                  {x.supplierId} <span className="muted small">{x.kind.toLowerCase()}</span>
                </td>
                <td>{x.qty}</td>
                <td>day {x.arrivalDays}</td>
                <td>{Math.round(x.costDelta * 100)}%</td>
                <td>{Math.round(x.onTimeRate * 100)}%</td>
                <td>{x.beforeStockout ? '✓' : '✗'}</td>
                <td>{x.feasible ? '✓' : '✗'}</td>
                <td>{x.score ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ActionTable({ d, planned }: { d: DecisionDoc; planned?: boolean }) {
  const rows = d.actions.length
    ? d.actions.map((a) => ({ ...a.action, status: a.status, poId: a.poId ?? a.action.poId, key: a.idempotencyKey, attempt: a.attempt, error: a.error?.message }))
    : (d.engine?.actions ?? []).map((a) => ({ ...a, status: planned ? 'PLANNED' : 'NOT RUN', key: '', attempt: 0, error: undefined as string | undefined }));
  if (!rows.length) return <p className="muted">No actions — this decision moves no money.</p>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>#</th>
          <th>Action</th>
          <th>PO</th>
          <th>Supplier</th>
          <th>Qty</th>
          <th>Status</th>
          <th>Attempt / key</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{i}</td>
            <td>{r.type}</td>
            <td>{r.poId ?? '—'}</td>
            <td>{r.supplierId}</td>
            <td>{r.qty}</td>
            <td>
              <span className={`st st-${String(r.status).toLowerCase().replace(' ', '-')}`}>{r.status}</span>
              {r.error && <div className="small bad">{r.error}</div>}
            </td>
            <td className="small mono">{r.key ? `${r.attempt} · ${r.key}` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Trace({ calls, rejected }: { calls: ToolCallRecord[]; rejected: { turn: number; problems: string[] }[] }) {
  const turns = [...new Set(calls.map((c) => c.turn))];
  return (
    <div className="trace">
      {turns.map((t) => (
        <div key={t} className="turn">
          <div className="turn-h">Turn {t}</div>
          {calls
            .filter((c) => c.turn === t)
            .map((c, i) => (
              <Call key={i} c={c} />
            ))}
          {rejected
            .filter((r) => r.turn === t)
            .map((r, i) => (
              <div key={i} className="guard">
                Guard rejected the submission: {r.problems.join('; ')}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

function Call({ c }: { c: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`call ${c.ok ? '' : 'failed'}`}>
      <button className="call-h" onClick={() => setOpen(!open)}>
        <span className="mono">{c.name}</span>
        <span className="small muted">
          {c.ms}ms {c.ok ? '' : `· ${c.error}`}
        </span>
        <span className="caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="call-b">
          <div>
            <h5>input</h5>
            <pre>{JSON.stringify(c.input, null, 2)}</pre>
          </div>
          <div>
            <h5>output</h5>
            <pre>{JSON.stringify(c.output, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
