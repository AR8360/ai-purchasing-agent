import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { DecisionPill, StateBadge } from './StateBadge';

export function DecisionList({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const q = useQuery({ queryKey: ['decisions'], queryFn: api.decisions, refetchInterval: 2500 });
  return (
    <div className="card list">
      <h3>Inbox</h3>
      {q.isLoading && <p className="muted">Loading…</p>}
      {q.data?.length === 0 && <p className="muted">No decisions yet.</p>}
      <ul>
        {q.data?.map((d) => (
          <li key={d.decisionId} className={selected === d.decisionId ? 'selected' : ''} onClick={() => onSelect(d.decisionId)}>
            <div className="row">
              <strong>{d.decisionId}</strong>
              <StateBadge state={d.state} />
            </div>
            <div className="row small">
              <span>
                {d.trigger.type === 'RECOMMENDATION'
                  ? `Rec ${d.trigger.qty} × ${d.trigger.sku}`
                  : `Shortfall ${d.trigger.poId} → ${d.trigger.confirmedQty}`}
              </span>
              <DecisionPill decision={d.decision?.decision} strategy={d.decision?.strategy} />
            </div>
            {d.faults?.length ? <div className="small muted">faults: {d.faults.join(', ')}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
