import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FAULTS } from '@purchasing/shared';
import { api } from '../api';

export function SimulatePanel({ onStarted }: { onStarted: (id: string) => void }) {
  const qc = useQueryClient();
  const variants = useQuery({ queryKey: ['variants'], queryFn: api.variants });
  const [variant, setVariant] = useState('s1-b');
  const [override, setOverride] = useState(false);
  const [faults, setFaults] = useState<string[]>([]);
  const [showExpected, setShowExpected] = useState(false);
  const v = variants.data?.find((x) => x.name === variant);

  const run = useMutation({
    mutationFn: () => api.runVariant(variant, override ? faults : undefined),
    onSuccess: (r) => {
      onStarted(r.decisionId);
      qc.invalidateQueries({ queryKey: ['decisions'] });
    },
  });

  return (
    <div className="card simulate">
      <h3>Simulate</h3>
      <label className="field">
        <span>Scenario</span>
        <select value={variant} onChange={(e) => setVariant(e.target.value)}>
          {variants.data?.map((x) => (
            <option key={x.name} value={x.name}>
              {x.name} — {x.name.startsWith('s1') ? 'Scenario 1 · recommendation review' : 'Scenario 2 · supplier shortfall'}
            </option>
          ))}
        </select>
      </label>
      {v && (
        <p className="hint">
          <span>
            Trigger:{' '}
            {v.trigger.type === 'RECOMMENDATION'
              ? `recommend ${v.trigger.qty} × ${v.trigger.sku} from ${v.trigger.supplierId}`
              : `${v.trigger.poId} confirmed only ${v.trigger.confirmedQty}`}
            {v.faults.length ? ` · faults: ${v.faults.join(', ')}` : ''}
          </span>
          {showExpected && (
            <>
              <br />
              <span className="muted">Expected: {v.description}</span>
            </>
          )}
        </p>
      )}
      <label className="check">
        <input type="checkbox" checked={showExpected} onChange={(e) => setShowExpected(e.target.checked)} /> Show expected outcome
      </label>
      <label className="check">
        <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Override faults
      </label>
      {override && (
        <div className="faults">
          {FAULTS.map((f) => (
            <label key={f} className="check">
              <input
                type="checkbox"
                checked={faults.includes(f)}
                onChange={(e) => setFaults(e.target.checked ? [...faults, f] : faults.filter((x) => x !== f))}
              />
              {f}
            </label>
          ))}
        </div>
      )}
      <button className="primary" disabled={run.isPending} onClick={() => run.mutate()}>
        {run.isPending ? 'Starting…' : 'Seed world & run agent'}
      </button>
      {run.error && <p className="error">{(run.error as Error).message}</p>}
    </div>
  );
}
