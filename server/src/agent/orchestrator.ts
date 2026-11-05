import { isTerminal, type DecisionDoc, type Trigger } from '@purchasing/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { requiresApproval } from '../engine/policy.js';
import { transition } from '../engine/stateMachine.js';
import { getTerms } from '../tools/data.js';
import { PurchaseOrderModel } from '../models/index.js';
import { CachingLLM, readFixtureManifest } from './llmCache.js';
import { createLLM, type LLMClient } from './llm.js';
import { execute, toolCtx } from './execute.js';
import { buildExplanation } from './explain.js';
import { investigate } from './loop.js';
import { loadDecision, newDecision, persist } from './store.js';

/**
 * Runs a decision end to end: investigate (LLM) → policy gate → execute → validate
 * → reconcile. Runs in the background; callers get the id immediately and can await
 * completion with waitFor().
 */

let llm: LLMClient | null = null;

export function getLlm(): LLMClient {
  if (!llm) {
    const mode = config.llm.cacheMode;
    // Replay never calls the model. Record without a key also runs offline: recorded
    // scenarios replay, and anything not recorded fails with a clear message.
    const live = mode === 'replay' || (mode === 'record' && !config.llm.apiKey) ? null : createLLM();
    const meta =
      (mode === 'replay' && readFixtureManifest(config.paths.fixtures)) || { provider: config.llm.provider, model: config.llm.model };
    llm = mode === 'off' ? live! : new CachingLLM(live, mode, config.paths.fixtures, meta);
  }
  return llm;
}

/** Swap the LLM (used by the eval runner); returns a restore function. */
export function useLlm(next: LLMClient) {
  const prev = llm;
  llm = next;
  return () => {
    llm = prev;
  };
}

const running = new Map<string, Promise<DecisionDoc>>();

export function waitFor(decisionId: string): Promise<DecisionDoc | null> {
  return running.get(decisionId) ?? loadDecision(decisionId);
}

function track(d: DecisionDoc, work: () => Promise<void>): Promise<DecisionDoc> {
  const p = work()
    .catch(async (e) => {
      // Safety net: an unexpected error must still leave an explained, terminal record.
      d.error = (e as Error).message;
      if (!isTerminal(d.state)) {
        d.transitions.push({ from: d.state, to: 'ESCALATED', at: clock.wallIso(), reason: `Internal error: ${d.error}` });
        d.state = 'ESCALATED';
        d.escalation = { summary: `The agent hit an error: ${d.error}`, options: [{ label: 'Review manually', detail: 'Inspect the trace' }] };
      }
      await persist(d).catch(() => undefined);
    })
    .then(async () => {
      await snapshotPurchaseOrders(d).catch(() => undefined);
      return d;
    })
    .finally(() => running.delete(d.decisionId));
  running.set(d.decisionId, p);
  return p;
}

/** Keep the POs exactly as this decision left them, so the trace stays meaningful after re-seeding. */
async function snapshotPurchaseOrders(d: DecisionDoc) {
  let sku: string | undefined;
  let node: string | undefined;
  if (d.trigger.type === 'RECOMMENDATION') ({ sku, node } = d.trigger);
  else {
    const po = await PurchaseOrderModel.findOne({ poId: d.trigger.poId }).lean();
    sku = po?.sku;
    node = po?.node;
  }
  if (!sku || !node) return;
  d.finalPurchaseOrders = (await PurchaseOrderModel.find({ sku, node }, { _id: 0 }).sort({ poId: 1 }).lean()) as any;
  await persist(d);
}

export async function startDecision(trigger: Trigger, faults: string[] = []): Promise<{ decisionId: string; done: Promise<DecisionDoc> }> {
  const model = getLlm();
  const d = newDecision(trigger, faults, model);
  await persist(d);
  const done = track(d, () => runDecision(d, model));
  return { decisionId: d.decisionId, done };
}

async function runDecision(d: DecisionDoc, model: LLMClient) {
  const decided = await investigate(d, model);
  if (!decided) return;
  const sub = d.decision!;
  const engine = d.engine!;

  if (sub.decision === 'REJECT' || sub.decision === 'INVESTIGATE') {
    transition(d, 'NO_ACTION', { at: clock.wallIso(), reason: sub.decision === 'REJECT' ? 'No purchase needed' : 'Waiting for better data' });
    d.explanation = buildExplanation(d);
    return persist(d);
  }
  if (sub.decision === 'ESCALATE') {
    d.escalation = engine.escalation ?? { summary: engine.summary, options: [] };
    transition(d, 'ESCALATED', { at: clock.wallIso(), reason: engine.summary });
    d.explanation = buildExplanation(d);
    return persist(d);
  }

  const policy = await policyFor(d);
  d.approval = { required: policy.required, reasons: policy.reasons };
  if (policy.required) {
    transition(d, 'NEEDS_APPROVAL', { at: clock.wallIso(), reason: policy.reasons.join('; ') });
    d.explanation = buildExplanation(d);
    return persist(d);
  }
  await persist(d);
  await execute(d);
}

async function policyFor(d: DecisionDoc) {
  const ctx = toolCtx(d);
  const actions = d.engine!.actions;
  const unitCostBySupplier: Record<string, number> = {};
  for (const a of actions) {
    if (a.type === 'CREATE_PO' && unitCostBySupplier[a.supplierId] === undefined) {
      unitCostBySupplier[a.supplierId] = (await getTerms(ctx, a.supplierId, a.sku)).unitCost;
    }
  }
  const sf = d.computed.shortfall as { originalSupplierId: string; originalUnitCost: number } | undefined;
  return requiresApproval({
    decision: d.decision!.decision,
    strategy: d.engine!.strategy,
    actions,
    recommendedQty: d.trigger.type === 'RECOMMENDATION' ? d.trigger.qty : undefined,
    originalSupplierId: sf?.originalSupplierId,
    originalUnitCost: sf?.originalUnitCost,
    unitCostBySupplier,
  });
}

export class DecisionStateError extends Error {}

export async function approveDecision(decisionId: string, by = 'buyer') {
  const d = await loadDecision(decisionId);
  if (!d) throw new DecisionStateError(`Decision ${decisionId} not found`);
  if (d.state !== 'NEEDS_APPROVAL' || running.has(decisionId)) throw new DecisionStateError(`Decision is ${d.state}, not awaiting approval`);
  d.approval = { ...d.approval, by, at: clock.wallIso(), outcome: 'APPROVED' };
  const done = track(d, () => execute(d));
  return { decisionId, done };
}

export async function rejectDecision(decisionId: string, by = 'buyer') {
  const d = await loadDecision(decisionId);
  if (!d) throw new DecisionStateError(`Decision ${decisionId} not found`);
  if (d.state !== 'NEEDS_APPROVAL') throw new DecisionStateError(`Decision is ${d.state}, not awaiting approval`);
  d.approval = { ...d.approval, by, at: clock.wallIso(), outcome: 'REJECTED' };
  transition(d, 'NO_ACTION', { at: clock.wallIso(), reason: `Rejected by ${by}` });
  d.explanation = buildExplanation(d);
  await persist(d);
  return d;
}
