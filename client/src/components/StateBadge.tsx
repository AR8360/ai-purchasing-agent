export function StateBadge({ state }: { state: string }) {
  return <span className={`badge state-${state.toLowerCase()}`}>{state.replace('_', ' ')}</span>;
}

const STRATEGY_LABEL: Record<string, string> = { ACCEPT_PARTIAL: 'PARTIAL', SPLIT: 'SPLIT', RESOURCE: 'RE-SOURCE' };

export function DecisionPill({ decision, strategy }: { decision?: string | null; strategy?: string | null }) {
  if (!decision) return <span className="muted">—</span>;
  return (
    <span className={`pill d-${decision.toLowerCase()}`}>
      {decision}
      {strategy && strategy !== 'STANDARD' ? ` · ${STRATEGY_LABEL[strategy] ?? strategy}` : ''}
    </span>
  );
}
