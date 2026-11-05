import type { DecisionDoc, Escalation, EscalationOption, ReconcileMove } from '@purchasing/shared';
import { clock } from '../clock.js';
import { requiresApproval, POLICY_LIMITS } from '../engine/policy.js';
import { adjustForMoq, backoffMs, classify } from '../engine/reconciler.js';
import { transition } from '../engine/stateMachine.js';
import { capacityForOrder, getPo } from '../tools/data.js';
import { cancelPurchaseOrder, revertAmendment } from '../tools/writes.js';
import { execute, idempotencyKey, toolCtx, type Failure } from './execute.js';
import { buildExplanation } from './explain.js';
import { persist } from './store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The feedback loop's decision point. Picks exactly one move (RETRY / ADJUST /
 * COMPENSATE / ESCALATE), records why, and either re-enters execution or ends in a
 * clean, explained state for a human.
 */
export async function reconcile(d: DecisionDoc, f: Failure): Promise<void> {
  transition(d, 'RECONCILING', { at: clock.wallIso(), reason: `${f.kind}: ${f.detail}` });
  const rec = f.actionIndex == null ? null : d.actions[f.actionIndex]!;
  const movesFor = (m: ReconcileMove) => d.reconciliations.filter((r) => r.move === m && r.actionIndex === (rec?.index ?? -1)).length;
  const completed = d.actions.filter((a) => a.status === 'DONE').length;
  const move = classify({ kind: f.kind, retries: movesFor('RETRY'), adjusts: movesFor('ADJUST'), completedActions: completed });
  const record = (m: ReconcileMove, detail: string) =>
    d.reconciliations.push({ move: m, failure: f.kind, detail, actionIndex: rec?.index ?? -1, at: clock.wallIso() });

  if (move === 'RETRY') {
    const wait = backoffMs(movesFor('RETRY'));
    record(
      'RETRY',
      rec?.status === 'FAILED'
        ? `${f.detail}; resending the same request with the same idempotency key after ${wait}ms`
        : `${f.detail}; the write succeeded but is not visible yet, re-reading after ${wait}ms`,
    );
    await persist(d);
    await sleep(wait);
    if (rec && rec.status === 'FAILED') rec.status = 'PENDING'; // same key → no duplicate on the server
    return execute(d);
  }

  if (move === 'ADJUST' && rec) {
    const plan = await planAdjustment(d, f);
    if (plan.ok) {
      record('ADJUST', plan.detail);
      const originalQty = rec.action.qty;
      rec.action = { ...rec.action, qty: plan.newQty };
      if (plan.resubmit) {
        rec.attempt += 1;
        rec.idempotencyKey = idempotencyKey(d.decisionId, rec.index, rec.action, rec.attempt);
        rec.status = 'PENDING';
      }
      const growth = (plan.newQty - originalQty) / originalQty;
      const policy = requiresApproval({
        decision: d.decision!.decision,
        strategy: d.engine!.strategy,
        actions: d.actions.map((a) => a.action),
        unitCostBySupplier: { [rec.action.supplierId]: plan.unitCost },
        afterFailure: { move: 'ADJUST', growth },
      });
      if (policy.required) {
        d.approval = { required: true, reasons: policy.reasons };
        transition(d, 'NEEDS_APPROVAL', { at: clock.wallIso(), reason: `Adjusted plan needs approval: ${policy.reasons.join('; ')}` });
        await persist(d);
        return;
      }
      await persist(d);
      return execute(d);
    }
    record('ADJUST', `Considered and rejected: ${plan.detail}`);
    await persist(d);
    // Fall through: an adjustment that does not fit means undoing what was done.
    return compensateAndEscalate(d, f, plan.detail);
  }

  if (move === 'COMPENSATE') return compensateAndEscalate(d, f, f.detail);

  record('ESCALATE', f.detail);
  return escalate(d, f, f.detail);
}

async function planAdjustment(
  d: DecisionDoc,
  f: Failure,
): Promise<{ ok: boolean; newQty: number; unitCost: number; resubmit: boolean; detail: string }> {
  const ctx = toolCtx(d);
  const rec = d.actions[f.actionIndex!]!;
  const a = rec.action;
  let newQty = a.qty;
  let resubmit = true;
  let deliveryInDays = a.expectedInDays;

  if (f.kind === 'MOQ_REJECTED') {
    const moq = Number((rec.error?.details as any)?.moq);
    const pack = Number((rec.error?.details as any)?.packSize ?? 1);
    newQty = adjustForMoq(a.qty, moq, pack);
  } else if (f.kind === 'QTY_MISMATCH') {
    const po = await getPo(ctx, rec.poId!);
    newQty = po.qty;
    resubmit = false; // the PO exists; we are deciding whether to keep it as it is
    deliveryInDays = po.expectedInDays;
  }

  const cap = await capacityForOrder(ctx, {
    sku: a.sku,
    node: a.node,
    supplierId: a.supplierId,
    deliveryInDays,
    excludePoId: f.kind === 'QTY_MISMATCH' ? rec.poId : undefined,
  });
  const extraCost = f.kind === 'QTY_MISMATCH' ? (newQty - a.qty) * cap.unitCost : newQty * cap.unitCost;
  const budgetOk = extraCost <= cap.budgetRemaining;
  const storageOk = newQty <= cap.storageFree;
  const growth = (newQty - a.qty) / a.qty;
  const growthOk = growth <= POLICY_LIMITS.maxAutoAdjustGrowth;
  const why = [
    `${a.supplierId} ${f.kind === 'MOQ_REJECTED' ? 'now requires' : 'recorded'} ${newQty} (was ${a.qty}, +${Math.round(growth * 100)}%)`,
    `budget ${budgetOk ? 'ok' : `short (needs ${extraCost}, remaining ${cap.budgetRemaining})`}`,
    `storage ${storageOk ? 'ok' : `short (${newQty} > ${cap.storageFree} free)`}`,
  ];
  if (!growthOk) why.push(`growth above the ${POLICY_LIMITS.maxAutoAdjustGrowth * 100}% adjust limit`);
  return { ok: budgetOk && storageOk && growthOk, newQty, unitCost: cap.unitCost, resubmit, detail: why.join('; ') };
}

/** Undo completed actions in reverse order, then escalate with a clean state. */
async function compensateAndEscalate(d: DecisionDoc, f: Failure, reason: string) {
  const ctx = toolCtx(d);
  const undone: string[] = [];
  for (const rec of [...d.actions].reverse()) {
    if (rec.status !== 'DONE' || !rec.poId) continue;
    if (rec.action.type === 'AMEND_PO') {
      await revertAmendment(ctx, rec.poId, `Compensating decision ${d.decisionId}`);
      undone.push(`Reverted ${rec.poId} to ${rec.before?.qty}`);
    } else {
      await cancelPurchaseOrder(ctx, rec.poId, `Compensating decision ${d.decisionId}`);
      undone.push(`Cancelled ${rec.poId}`);
    }
    rec.status = 'REVERTED';
    rec.at = clock.wallIso();
  }
  d.reconciliations.push({
    move: 'COMPENSATE',
    failure: f.kind,
    detail: undone.length ? undone.join('; ') : 'Nothing to undo',
    actionIndex: f.actionIndex ?? -1,
    at: clock.wallIso(),
  });
  await persist(d);
  return escalate(d, f, reason);
}

async function escalate(d: DecisionDoc, f: Failure, reason: string) {
  d.escalation = escalationFor(d, f, reason);
  transition(d, 'ESCALATED', { at: clock.wallIso(), reason: `Escalated after ${f.kind}: ${reason}` });
  d.explanation = buildExplanation(d);
  await persist(d);
}

function escalationFor(d: DecisionDoc, f: Failure, reason: string): Escalation {
  const options: EscalationOption[] = [];
  const failed = f.actionIndex == null ? null : d.actions[f.actionIndex];
  const details = failed?.error?.details as { remaining?: number; requested?: number } | undefined;
  if (f.kind === 'BUDGET_EXCEEDED' && details?.requested && details.remaining !== undefined && failed && details.requested > details.remaining) {
    options.push({
      label: `Approve ₹${(details.requested - details.remaining).toLocaleString('en-IN')} extra budget`,
      detail: `Then order ${failed.action.qty} from ${failed.action.supplierId} as planned`,
    });
  }
  if (f.kind === 'QTY_MISMATCH' && failed) {
    options.push({ label: `Re-order ${failed.action.qty} manually`, detail: `The supplier portal changed the quantity; the PO was cancelled` });
  }
  options.push(...(d.engine?.escalation?.options ?? []));
  const sf = d.computed.shortfall as
    | {
        candidates?: { supplierId: string; qty: number; totalCost: number; costDelta: number; arrivalDays: number; beforeStockout: boolean; feasible: boolean; kind: string }[];
        stockoutDay?: number;
      }
    | undefined;
  if (sf?.candidates && !d.engine?.escalation) {
    for (const c of sf.candidates.filter((x) => x.beforeStockout && x.supplierId !== failed?.action.supplierId)) {
      options.push({
        label: `Re-source ${c.qty} from ${c.supplierId}`,
        detail: `₹${c.totalCost.toLocaleString('en-IN')} (+${Math.round(c.costDelta * 100)}%), arrives day ${c.arrivalDays}${c.feasible ? '' : '; exceeds the budget or storage limit, so it also needs an override'}`,
      });
    }
    options.push({ label: 'Accept the shortfall', detail: `Original PO left as it was; stockout risk from day ${sf.stockoutDay}` });
  }
  if (!options.length) options.push({ label: 'Review manually', detail: 'Inspect the trace and decide' });
  return { summary: `${reason}. All completed steps were undone; the systems are back in their original state.`, options };
}
