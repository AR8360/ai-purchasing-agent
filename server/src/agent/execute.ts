import type { Action, ActionRecord, DecisionDoc } from '@purchasing/shared';
import { clock } from '../clock.js';
import { failureKindFromHttp, type FailureKind } from '../engine/reconciler.js';
import { transition } from '../engine/stateMachine.js';
import { validateOutcome, validatePo, type ExpectedPo, type OutcomeCheck } from '../engine/validator.js';
import { capacityForOrder, getBudget, getPo, getSku, orNull } from '../tools/data.js';
import { HttpError } from '../tools/http.js';
import type { ToolContext } from '../tools/registry.js';
import { amendPurchaseOrder, commitAmendment, createPurchaseOrder } from '../tools/writes.js';
import { buildExplanation } from './explain.js';
import { reconcile } from './reconcile.js';
import { persist } from './store.js';

export interface Failure {
  kind: FailureKind;
  actionIndex: number | null;
  detail: string;
}

/** Idempotency key: same key on a RETRY (dedupe), new key after an ADJUST changes the request. */
export const idempotencyKey = (decisionId: string, index: number, a: Action, attempt: number) =>
  `${decisionId}:${index}:${a.type}:${attempt}`;

export const toolCtx = (d: DecisionDoc): ToolContext => ({ decision: d, decisionId: d.decisionId, faults: d.faults });

/**
 * Execute → validate. Runs pending actions in order (amend before create, so freed
 * budget is available), then reads every written record back and checks the whole
 * picture. Any mismatch hands control to the reconciler.
 */
export async function execute(d: DecisionDoc): Promise<void> {
  const ctx = toolCtx(d);
  transition(d, 'EXECUTING', { at: clock.wallIso(), reason: d.actions.length ? 'Re-executing after reconciliation' : 'Executing planned actions' });

  if (d.actions.length === 0) {
    // Execute the engine's canonical plan (the guard proved the submission matches it).
    d.actions = (d.engine?.actions ?? []).map((action, index) => ({
      index,
      action,
      attempt: 1,
      status: 'PENDING',
      idempotencyKey: idempotencyKey(d.decisionId, index, action, 1),
      at: clock.wallIso(),
    }));
  }
  await persist(d);

  for (const rec of d.actions) {
    if (rec.status !== 'PENDING' && rec.status !== 'FAILED') continue;
    try {
      await perform(ctx, rec);
      rec.status = 'DONE';
      rec.error = undefined;
      rec.at = clock.wallIso();
      await persist(d);
    } catch (e) {
      rec.status = 'FAILED';
      rec.at = clock.wallIso();
      rec.error =
        e instanceof HttpError
          ? { code: e.code ?? 'HTTP_ERROR', status: e.status, message: e.message, details: e.body }
          : { code: 'ERROR', message: (e as Error).message };
      await persist(d);
      const kind = e instanceof HttpError ? failureKindFromHttp(e.status, e.code) : 'OTHER';
      return reconcile(d, { kind, actionIndex: rec.index, detail: rec.error.message });
    }
  }

  transition(d, 'VALIDATING', { at: clock.wallIso(), reason: 'Reading every written record back' });
  await persist(d);

  for (const rec of d.actions.filter((a) => a.status === 'DONE')) {
    const observed = await orNull(getPo(ctx, rec.poId!));
    const expected = expectedFor(rec);
    const v = validatePo(expected, observed);
    d.validations.push({ kind: 'PO', actionIndex: rec.index, ok: v.ok, diffs: v.diffs, at: clock.wallIso() });
    await persist(d);
    if (!v.ok) {
      const kind: FailureKind = observed ? 'QTY_MISMATCH' : 'NOT_FOUND';
      const detail = observed
        ? v.diffs.map((x) => `${x.field}: expected ${x.expected}, got ${x.observed}`).join('; ')
        : `${rec.poId} not found on read-back`;
      return reconcile(d, { kind, actionIndex: rec.index, detail });
    }
  }

  const outcome = validateOutcome(await outcomeChecks(d, ctx));
  d.validations.push({ kind: 'OUTCOME', actionIndex: null, ok: outcome.ok, diffs: [], checks: outcome.checks, at: clock.wallIso() });
  await persist(d);
  if (!outcome.ok) {
    return reconcile(d, { kind: 'OUTCOME_FAILED', actionIndex: null, detail: outcome.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ') });
  }

  // Soft amendments become real only now that the whole decision has validated.
  for (const rec of d.actions.filter((a) => a.status === 'DONE' && a.action.type === 'AMEND_PO')) {
    await commitAmendment(ctx, rec.poId!, `Decision ${d.decisionId} validated`);
  }
  transition(d, 'VALIDATED', { at: clock.wallIso(), reason: 'All actions confirmed by read-back and outcome checks' });
  d.explanation = buildExplanation(d);
  await persist(d);
}

async function perform(ctx: ToolContext, rec: ActionRecord) {
  const a = rec.action;
  if (a.type === 'CREATE_PO') {
    const po = await createPurchaseOrder(ctx, {
      sku: a.sku,
      node: a.node,
      supplierId: a.supplierId,
      qty: a.qty,
      expectedInDays: a.expectedInDays,
      idempotencyKey: rec.idempotencyKey,
    });
    rec.poId = po.poId;
    return;
  }
  // AMEND_PO (soft): remember the state before, so it can be reverted.
  const before = await getPo(ctx, a.poId!);
  rec.before = rec.before ?? { qty: before.qty, pendingQty: before.pendingQty };
  await amendPurchaseOrder(ctx, a.poId!, a.qty, a.reason);
  rec.poId = a.poId;
}

function expectedFor(rec: ActionRecord): ExpectedPo {
  const a = rec.action;
  if (a.type === 'CREATE_PO') {
    return { poId: rec.poId, supplierId: a.supplierId, qty: a.qty, pendingQty: null, statusIn: ['CREATED'] };
  }
  return { poId: a.poId, supplierId: a.supplierId, qty: rec.before!.qty, pendingQty: a.qty, statusIn: ['CREATED', 'CONFIRMED', 'SHIPPED'] };
}

/** Whole-picture checks: budget, storage on each delivery day, and (Scenario 2) coverage restored. */
async function outcomeChecks(d: DecisionDoc, ctx: ToolContext): Promise<OutcomeCheck[]> {
  const checks: OutcomeCheck[] = [];
  const first = d.actions[0]?.action;
  if (!first) return checks;
  const sku = await getSku(ctx, first.sku);
  const budget = await getBudget(ctx, first.node, sku.category);
  checks.push({
    name: 'budget_within_limit',
    ok: budget.reserved + budget.spent <= budget.total,
    detail: `reserved ${budget.reserved} + spent ${budget.spent} of total ${budget.total}`,
  });

  for (const rec of d.actions.filter((a) => a.status === 'DONE' && a.action.type === 'CREATE_PO')) {
    const po = await getPo(ctx, rec.poId!);
    const cap = await capacityForOrder(ctx, {
      sku: po.sku,
      node: po.node,
      supplierId: po.supplierId,
      deliveryInDays: po.expectedInDays,
      excludePoId: po.poId,
    });
    checks.push({
      name: `storage_fits_${po.poId}`,
      ok: po.qty <= cap.storageFree,
      detail: `${po.poId} delivers ${po.qty} on day ${po.expectedInDays}; free storage then ${cap.storageFree}`,
    });
  }

  const sf = d.computed.shortfall as { orderedQty: number; confirmedQty: number } | undefined;
  if (sf && d.engine && (d.engine.strategy === 'SPLIT' || d.engine.strategy === 'RESOURCE')) {
    const created = d.actions.filter((a) => a.status === 'DONE' && a.action.type === 'CREATE_PO').reduce((s, a) => s + a.action.qty, 0);
    checks.push({
      name: 'coverage_restored',
      ok: sf.confirmedQty + created >= sf.orderedQty,
      detail: `${sf.confirmedQty} confirmed + ${created} new ≥ ${sf.orderedQty} originally ordered`,
    });
  }
  return checks;
}
