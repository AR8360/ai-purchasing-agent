import type { DecisionDoc } from '@purchasing/shared';

/**
 * Buyer-facing note. Deterministic text assembly from the trace plus the model's
 * reasoning bullets; no second LLM call, so it can never contradict the trace.
 */
export function buildExplanation(d: DecisionDoc): string {
  const lines: string[] = [];
  const t = d.trigger;
  const sub = d.decision;
  const head =
    t.type === 'RECOMMENDATION'
      ? `Recommendation: buy ${t.qty} × ${t.sku} at ${t.node} from ${t.supplierId}.`
      : `Supplier shortfall: ${t.poId} confirmed ${t.confirmedQty}.`;
  lines.push(head);
  if (sub) {
    const q = sub.quantity !== undefined && sub.decision !== 'REJECT' ? ` ${sub.quantity}` : '';
    lines.push(`Decision: ${sub.decision}${sub.strategy && sub.strategy !== 'STANDARD' ? ` (${sub.strategy})` : ''}${q}.`);
  }
  if (d.engine) lines.push(`Why: ${d.engine.summary}.`);
  for (const r of sub?.reasoning ?? []) lines.push(`• ${r}`);

  const done = d.actions.filter((a) => a.status === 'DONE');
  const reverted = d.actions.filter((a) => a.status === 'REVERTED');
  if (done.length) {
    lines.push(
      `Actions: ${done.map((a) => (a.action.type === 'CREATE_PO' ? `created ${a.poId} (${a.action.qty} from ${a.action.supplierId})` : `amended ${a.poId} to ${a.action.qty}`)).join('; ')}.`,
    );
  }
  if (d.reconciliations.length) {
    lines.push(`Recovery: ${d.reconciliations.map((r) => `${r.move} — ${r.detail}`).join(' → ')}.`);
  }
  if (reverted.length) lines.push(`Undone: ${reverted.map((a) => a.poId).join(', ')}.`);
  const failedChecks = d.validations.filter((v) => !v.ok).length;
  if (d.state === 'VALIDATED') lines.push(`Validated: ${d.validations.length - failedChecks} checks passed after read-back${failedChecks ? ` (${failedChecks} earlier check(s) failed and were reconciled)` : ''}.`);
  if (d.escalation) {
    lines.push(`Needs a decision: ${d.escalation.summary}`);
    d.escalation.options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label} — ${o.detail}`));
  }
  const gap = (d.engine?.details as { coverageGap?: number } | undefined)?.coverageGap;
  if (gap && d.state === 'VALIDATED') lines.push(`Follow-up: ${gap} units of need remain uncovered because of the binding constraint; re-review after incoming stock lands.`);
  return lines.join('\n');
}
